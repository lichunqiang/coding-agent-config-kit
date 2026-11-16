import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultModel } from "../../src/addons/default-model.js";
import { createConfigKit } from "../../src/kit.js";
import { parseDotenv } from "../../src/editing/dotenv.js";
import type { ConfigKit, ResolveAndPlanRequest } from "../../src/types.js";

let home: string;
let kit: ConfigKit;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "config-kit-gemini-"));
  kit = createConfigKit({
    ownerId: "owner",
    resolveCredential: () => "super-secret-key",
    addons: [defaultModel({ modelId: "m1" })],
    lock: { timeoutMs: 300 },
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const agentDir = (): string => join(home, ".gemini");

function request(overrides: Partial<ResolveAndPlanRequest> = {}): ResolveAndPlanRequest {
  return {
    agent: "gemini-cli",
    target: {
      launchEnvironment: { GEMINI_CLI_HOME: home, GEMINI_API_KEY: "injected" },
    },
    provider: {
      id: "gemini-gateway",
      protocol: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com",
      credential: {
        source: { kind: "reference", id: "acct" },
        placement: { kind: "external-env", envVar: "GEMINI_API_KEY" },
      },
    },
    models: { fallbackIds: ["m1"] },
    ...overrides,
  };
}

async function settings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(agentDir(), "settings.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Gemini CLI adapter", () => {
  it("writes base URL and default model without persisting the key", async () => {
    const plan = await kit.resolveAndPlan(request());
    expect(plan.preview.blockers).toEqual([]);
    expect((await kit.apply(plan)).status).toBe("applied");

    const env = parseDotenv(await readFile(join(agentDir(), ".env"), "utf8"));
    expect(env.GOOGLE_GEMINI_BASE_URL).toBe("https://generativelanguage.googleapis.com");
    expect(env.GEMINI_API_KEY).toBeUndefined();

    const parsed = await settings();
    expect((parsed.model as Record<string, unknown>).name).toBe("m1");

    expect((await kit.apply(await kit.resolveAndPlan(request()))).status).toBe("unchanged");
  });

  it("writes an agent-file key without leaking it into the preview", async () => {
    const plan = await kit.resolveAndPlan(
      request({
        provider: {
          ...request().provider!,
          credential: {
            source: { kind: "reference", id: "acct" },
            placement: { kind: "agent-file" },
          },
        },
      }),
    );
    const diff = plan.preview.changes[1]?.redactedDiff ?? "";
    expect(diff).not.toContain("super-secret-key");
    expect(diff).toContain("[redacted]");

    await kit.apply(plan);
    const env = parseDotenv(await readFile(join(agentDir(), ".env"), "utf8"));
    expect(env.GEMINI_API_KEY).toBe("super-secret-key");
  });

  it("requires adoption for an unmanaged key", async () => {
    await mkdir(agentDir(), { recursive: true });
    await writeFile(join(agentDir(), ".env"), "GEMINI_API_KEY=existing\n", "utf8");
    const provider = {
      ...request().provider!,
      credential: {
        source: { kind: "reference" as const, id: "acct" },
        placement: { kind: "agent-file" as const },
      },
    };
    const blocked = await kit.resolveAndPlan(request({ provider }));
    expect(blocked.preview.blockers).toContainEqual(
      expect.objectContaining({ code: "OWNERSHIP_CONFLICT" }),
    );
    expect((await kit.apply(blocked)).status).toBe("failed");

    const adopted = await kit.resolveAndPlan(
      request({
        provider,
        ownership: { adoptCredentialFields: ["GEMINI_API_KEY"] },
      }),
    );
    await kit.apply(adopted);
    const env = parseDotenv(await readFile(join(agentDir(), ".env"), "utf8"));
    expect(env.GEMINI_API_KEY).toBe("super-secret-key");
  });

  it("removes a managed key when switching to external-env", async () => {
    const filePlan = await kit.resolveAndPlan(
      request({
        provider: {
          ...request().provider!,
          credential: {
            source: { kind: "reference", id: "acct" },
            placement: { kind: "agent-file" },
          },
        },
      }),
    );
    await kit.apply(filePlan);

    const external = await kit.resolveAndPlan(request());
    expect(external.preview.warnings).toContainEqual(
      expect.objectContaining({ code: "GEMINI_STALE_KEY_REMOVED" }),
    );
    await kit.apply(external);
    const env = parseDotenv(await readFile(join(agentDir(), ".env"), "utf8"));
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it("marks workspace settings and launch overrides", async () => {
    const projectDir = join(home, "project");
    await mkdir(join(projectDir, ".gemini"), { recursive: true });
    await writeFile(join(projectDir, ".gemini", "settings.json"), "{}", "utf8");

    const plan = await kit.resolveAndPlan(
      request({ target: { launchEnvironment: { GEMINI_CLI_HOME: home, GEMINI_API_KEY: "x" }, projectDir } }),
    );
    expect(plan.preview.effectiveness.level).toBe("may-be-overridden");
  });
});