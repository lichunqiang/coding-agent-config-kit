import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultModel } from "../../src/addons/default-model.js";
import { createConfigKit } from "../../src/kit.js";
import type { ConfigKit, ResolveAndPlanRequest } from "../../src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "config-kit-claude-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function kitWith(addon = defaultModel({ modelId: "m1" })): ConfigKit {
  return createConfigKit({
    ownerId: "owner",
    resolveCredential: () => "super-secret-key",
    addons: [addon],
    lock: { timeoutMs: 300 },
  });
}

function request(overrides: Partial<ResolveAndPlanRequest> = {}): ResolveAndPlanRequest {
  return {
    agent: "claude-code",
    target: {
      configDir: dir,
      launchEnvironment: {
        CLAUDE_CONFIG_DIR: dir,
        ANTHROPIC_AUTH_TOKEN: "from-launch-env",
      },
    },
    provider: {
      id: "anthropic-gateway",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      credential: {
        source: { kind: "reference", id: "acct" },
        placement: { kind: "external-env", envVar: "ANTHROPIC_AUTH_TOKEN" },
      },
    },
    models: {
      fallbackIds: ["m1"],
      overrides: { m1: { contextWindow: 200_000 } },
    },
    ...overrides,
  };
}

async function settings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Claude Code adapter", () => {
  it("writes the connection URL and all four default model fields", async () => {
    const kit = kitWith();
    const plan = await kit.resolveAndPlan(request());
    expect(plan.preview.blockers).toEqual([]);

    expect((await kit.apply(plan)).status).toBe("applied");
    const env = (await settings()).env as Record<string, unknown>;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(env.ANTHROPIC_MODEL).toBe("m1");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("m1");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("m1");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("m1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

    const again = await kit.apply(await kit.resolveAndPlan(request()));
    expect(again.status).toBe("unchanged");
  });

  it("supports per-slot defaults", async () => {
    const kit = kitWith(
      defaultModel({ modelId: "m1", claudeCode: { slots: { opus: "opus-1" } } }),
    );
    await kit.apply(await kit.resolveAndPlan(request()));
    const env = (await settings()).env as Record<string, unknown>;
    expect(env.ANTHROPIC_MODEL).toBe("m1");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("opus-1");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("m1");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("m1");
  });

  it("writes an agent-file token without leaking it into the preview", async () => {
    const kit = kitWith();
    const plan = await kit.resolveAndPlan(
      request({
        provider: {
          id: "anthropic-gateway",
          protocol: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          credential: {
            source: { kind: "reference", id: "acct" },
            placement: { kind: "agent-file" },
          },
        },
      }),
    );
    const diff = plan.preview.changes[0]?.redactedDiff ?? "";
    expect(diff).not.toContain("super-secret-key");
    expect(diff).toContain("[redacted]");

    await kit.apply(plan);
    const env = (await settings()).env as Record<string, unknown>;
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("super-secret-key");
  });

  it("refuses to overwrite an unmanaged token without adoption", async () => {
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "existing-key" } }),
      "utf8",
    );
    const kit = kitWith();
    const provider = {
      id: "anthropic-gateway",
      protocol: "anthropic-messages" as const,
      baseUrl: "https://api.anthropic.com",
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
        ownership: { adoptCredentialFields: ["env.ANTHROPIC_AUTH_TOKEN"] },
      }),
    );
    expect((await kit.apply(adopted)).status).toBe("applied");
    const env = (await settings()).env as Record<string, unknown>;
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("super-secret-key");
  });

  it("removes a previously managed token when switching to external-env", async () => {
    const kit = kitWith();
    const filePlan = await kit.resolveAndPlan(
      request({
        provider: {
          id: "anthropic-gateway",
          protocol: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
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
      expect.objectContaining({ code: "CLAUDE_STALE_TOKEN_REMOVED" }),
    );
    expect((await kit.apply(external)).status).toBe("applied");
    const env = (await settings()).env as Record<string, unknown>;
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("marks project overrides as may-be-overridden", async () => {
    const projectDir = join(dir, "project");
    await mkdir(join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      join(projectDir, ".claude", "settings.local.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://project.example" } }),
      "utf8",
    );
    const kit = kitWith();
    const plan = await kit.resolveAndPlan(
      request({ target: { configDir: dir, projectDir } }),
    );
    expect(plan.preview.effectiveness.level).toBe("may-be-overridden");
  });
});