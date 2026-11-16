import { readFileSync, readdirSync, statSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultModel } from "../../src/addons/default-model.js";
import { createConfigKit } from "../../src/kit.js";
import type { AgentId, Protocol, ResolveAndPlanRequest } from "../../src/types.js";

const FIXTURE_ROOT = join(process.cwd(), "fixtures", "agents");
const VERSION_REGISTRY = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures", "versions.json"), "utf8"),
) as VersionRegistry;

interface VersionRegistry {
  agents: Record<
    AgentId,
    { version: string | null; command: string; status: "installed" | "not-installed" }
  >;
}

interface Manifest {
  schemaVersion: 1;
  agent: AgentId;
  version: string;
  variant?: string;
  status: "installed-version" | "not-installed";
  configFormat?: "v1" | "v2";
  profile?: string;
  assertions: { preserveText: string[]; expectText: string[] };
}

interface Profile {
  protocol: Protocol;
  baseUrl: string;
  placement:
    | { kind: "env-reference"; envVar: string }
    | { kind: "external-env"; envVar: string };
  pathEnv?: string;
}

const PROFILES: Record<AgentId, Profile> = {
  pi: {
    protocol: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    placement: { kind: "env-reference", envVar: "FIXTURE_KEY" },
    pathEnv: "PI_CODING_AGENT_DIR",
  },
  "claude-code": {
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    placement: { kind: "external-env", envVar: "ANTHROPIC_AUTH_TOKEN" },
    pathEnv: "CLAUDE_CONFIG_DIR",
  },
  codex: {
    protocol: "openai-responses",
    baseUrl: "https://api.example.com/v1",
    placement: { kind: "env-reference", envVar: "FIXTURE_KEY" },
    pathEnv: "CODEX_HOME",
  },
  "gemini-cli": {
    protocol: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com",
    placement: { kind: "external-env", envVar: "GEMINI_API_KEY" },
    pathEnv: "GEMINI_CLI_HOME",
  },
  opencode: {
    protocol: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    placement: { kind: "env-reference", envVar: "FIXTURE_KEY" },
  },
  "deepseek-harness": {
    protocol: "openai-responses",
    baseUrl: "https://api.example.com/v1",
    placement: { kind: "env-reference", envVar: "FIXTURE_KEY" },
    pathEnv: "DSH_HOME",
  },
};

function findManifests(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      result.push(...findManifests(path));
    } else if (entry === "manifest.json") {
      result.push(path);
    }
  }
  return result.sort();
}

const manifests = findManifests(FIXTURE_ROOT).map((path) => ({
  path,
  dir: dirname(path),
  manifest: JSON.parse(readFileSync(path, "utf8")) as Manifest,
  id: relative(FIXTURE_ROOT, dirname(path)).replaceAll("\\", "/"),
}));

describe("version registry", () => {
  it("pins every installed agent to a real captured version", () => {
    for (const agent of Object.keys(PROFILES) as AgentId[]) {
      const entry = VERSION_REGISTRY.agents[agent];
      expect(entry, `missing registry entry for ${agent}`).toBeDefined();
      const agentFixtures = manifests.filter(({ manifest }) => manifest.agent === agent);
      expect(agentFixtures.length, `missing fixtures for ${agent}`).toBeGreaterThan(0);
      if (entry.status === "installed") {
        expect(entry.version, `installed ${agent} has no version`).not.toBeNull();
        expect(agentFixtures.map(({ manifest }) => manifest.version)).toContain(
          entry.version,
        );
        expect(agentFixtures.map(({ manifest }) => manifest.status)).toContain(
          "installed-version",
        );
      } else {
        expect(agentFixtures.every(({ manifest }) => manifest.version === "unpinned")).toBe(
          true,
        );
      }
    }
  });
});

describe("real Agent version fixtures", () => {
  for (const { dir, manifest, id } of manifests) {
    it(`plans, applies and stays idempotent for ${id}`, async () => {
      const temp = await mkdtemp(join(tmpdir(), "config-kit-acceptance-"));
      try {
        const profile = PROFILES[manifest.agent];
        const configDir = targetConfigDir(manifest, temp);
        await mkdir(configDir, { recursive: true });
        await copyFixtureFiles(join(dir, "before"), configDir);

        const launchEnvironment: Record<string, string> = {
          [profile.placement.envVar]: "fixture-value",
        };
        if (manifest.agent === "gemini-cli") {
          launchEnvironment.GEMINI_CLI_HOME = temp;
        } else if (manifest.agent === "deepseek-harness") {
          launchEnvironment.DSH_HOME = temp;
        } else if (profile.pathEnv !== undefined) {
          launchEnvironment[profile.pathEnv] = configDir;
        }

        const kit = createConfigKit({
          ownerId: `acceptance-${manifest.agent}-${manifest.variant ?? "default"}-${manifest.version}`,
          resolveCredential: () => "fixture-secret",
          addons: [defaultModel({ modelId: "fixture-model" })],
          lock: { timeoutMs: 2_000 },
        });

        const request: ResolveAndPlanRequest = {
          agent: manifest.agent,
          target: {
            configDir,
            launchEnvironment,
            ...(manifest.version === "unpinned"
              ? {}
              : { agentVersion: manifest.version }),
            ...(manifest.configFormat === undefined
              ? {}
              : { configFormat: manifest.configFormat }),
            ...(manifest.profile === undefined ? {} : { profile: manifest.profile }),
          },
          provider: {
            id: "fixture-provider",
            protocol: profile.protocol,
            baseUrl: profile.baseUrl,
            credential: {
              source: { kind: "reference", id: "fixture-account" },
              placement: profile.placement,
            },
          },
          models: {
            fallbackIds: ["fixture-model"],
            overrides: {
              "fixture-model": { contextWindow: 64_000, maxOutputTokens: 8_000 },
            },
          },
        };

        const plan = await kit.resolveAndPlan(request);
        expect(plan.preview.blockers).toEqual([]);
        if (manifest.version !== "unpinned") {
          expect(plan.preview.target.agentVersion).toBe(manifest.version);
        }

        const applied = await kit.apply(plan);
        expect(applied.status).toBe("applied");

        const text = await readAllText(configDir);
        for (const marker of manifest.assertions.preserveText) {
          expect(text, `fixture ${id} lost ${marker}`).toContain(marker);
        }
        for (const marker of manifest.assertions.expectText) {
          expect(text, `fixture ${id} did not write ${marker}`).toContain(marker);
        }

        const second = await kit.resolveAndPlan(request);
        const again = await kit.apply(second);
        expect(again.status).toBe("unchanged");
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    });
  }
});

function targetConfigDir(manifest: Manifest, temp: string): string {
  if (manifest.agent === "gemini-cli") return join(temp, ".gemini");
  if (manifest.agent === "deepseek-harness") {
    return join(temp, "profiles", manifest.profile ?? "fixture");
  }
  return temp;
}

async function copyFixtureFiles(beforeDir: string, configDir: string): Promise<void> {
  for (const entry of await readdir(beforeDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    await copyFile(join(beforeDir, entry.name), join(configDir, entry.name));
  }
}

async function readAllText(directory: string): Promise<string> {
  const chunks: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".coding-agent-config-kit") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      chunks.push(await readAllText(path));
    } else if (entry.isFile()) {
      chunks.push(await readFile(path, "utf8"));
    }
  }
  return chunks.join("\n");
}