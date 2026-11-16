import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultModel } from "../../src/addons/default-model.js";
import { createConfigKit } from "../../src/kit.js";
import type { ConfigKit, ResolveAndPlanRequest } from "../../src/types.js";

let dir: string;
let kit: ConfigKit;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "config-kit-opencode-"));
  kit = createConfigKit({
    ownerId: "owner",
    resolveCredential: () => "secret",
    addons: [defaultModel({ modelId: "m1" })],
    lock: { timeoutMs: 300 },
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function request(overrides: Partial<ResolveAndPlanRequest> = {}): ResolveAndPlanRequest {
  return {
    agent: "opencode",
    target: {
      configDir: dir,
      launchEnvironment: { TEST_KEY: "present" },
    },
    provider: {
      id: "company",
      protocol: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      credential: {
        source: { kind: "reference", id: "acct" },
        placement: { kind: "env-reference", envVar: "TEST_KEY" },
      },
    },
    models: {
      fallbackIds: ["m1"],
      overrides: {
        m1: {
          contextWindow: 64_000,
          maxOutputTokens: 8_000,
          reasoning: true,
          toolCalling: true,
          inputModalities: ["text", "pdf"],
        },
      },
    },
    ...overrides,
  };
}

async function config(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(dir, "opencode.json"), "utf8")) as Record<string, any>;
}

describe("OpenCode V2 adapter", () => {
  it("writes a provider, model capabilities and the default model", async () => {
    const plan = await kit.resolveAndPlan(request());
    expect(plan.preview.blockers).toEqual([]);
    expect((await kit.apply(plan)).status).toBe("applied");

    const parsed = await config();
    expect(parsed.model).toBe("company/m1");
    const provider = parsed.providers.company;
    expect(provider).toMatchObject({
      name: "company",
      env: ["TEST_KEY"],
      package: "@ai-sdk/openai-compatible",
    });
    expect(provider.models.m1).toMatchObject({
      name: "m1",
      limit: { context: 64_000, output: 8_000 },
      capabilities: {
        input: ["text"],
        tools: true,
        reasoning: { supported: true },
      },
    });
    expect(plan.preview.warnings).toContainEqual(
      expect.objectContaining({ code: "OPENCODE_MODALITY_DROPPED" }),
    );

    expect((await kit.apply(await kit.resolveAndPlan(request()))).status).toBe("unchanged");
  });

  it("refuses a V1 config", async () => {
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({ provider: { company: {} } }),
      "utf8",
    );
    const plan = await kit.resolveAndPlan(request());
    expect(plan.preview.blockers).toContainEqual(
      expect.objectContaining({ code: "TARGET_VERSION_CONFLICT" }),
    );
    expect((await kit.apply(plan)).status).toBe("failed");
  });

  it("refuses a config with both provider and providers", async () => {
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({ provider: {}, providers: {} }),
      "utf8",
    );
    const plan = await kit.resolveAndPlan(request());
    expect(plan.preview.blockers).toContainEqual(
      expect.objectContaining({ code: "TARGET_VERSION_CONFLICT" }),
    );
  });

  it("requires adoption for an existing unowned provider", async () => {
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({ providers: { company: { name: "old" } } }),
      "utf8",
    );
    const blocked = await kit.resolveAndPlan(request());
    expect(blocked.preview.blockers).toContainEqual(
      expect.objectContaining({ code: "OWNERSHIP_CONFLICT" }),
    );
    const adopted = await kit.resolveAndPlan(
      request({ ownership: { adopt: ["company"] } }),
    );
    expect((await kit.apply(adopted)).status).toBe("applied");
  });

  it("reports project config overrides", async () => {
    const projectDir = join(dir, "project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "opencode.json"), "{}", "utf8");
    const plan = await kit.resolveAndPlan(request({ target: { configDir: dir, projectDir } }));
    expect(plan.preview.effectiveness.level).toBe("may-be-overridden");
  });

  it("removes an owned provider and clears the default", async () => {
    await kit.apply(await kit.resolveAndPlan(request()));
    const removal = await kit.resolveAndPlan({
      agent: "opencode",
      target: { configDir: dir },
      lifecycle: { removeProviders: ["company"] },
    });
    expect(removal.preview.warnings).toContainEqual(
      expect.objectContaining({ code: "OPENCODE_DEFAULT_MODEL_REMOVED" }),
    );
    expect((await kit.apply(removal)).status).toBe("applied");
    const parsed = await config();
    expect(parsed.providers.company).toBeUndefined();
    expect(parsed.model).toBeUndefined();
  });
});