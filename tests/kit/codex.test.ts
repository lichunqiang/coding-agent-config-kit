import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultModel } from "../../src/addons/default-model.js";
import { createConfigKit } from "../../src/kit.js";
import { parseTomlText } from "../../src/editing/toml.js";
import type { ConfigKit, ResolveAndPlanRequest } from "../../src/types.js";

let dir: string;
let kit: ConfigKit;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "config-kit-codex-"));
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
    agent: "codex",
    target: {
      configDir: dir,
      launchEnvironment: { CODEX_HOME: dir, TEST_KEY: "present" },
    },
    provider: {
      id: "company",
      protocol: "openai-responses",
      baseUrl: "https://api.example.com/v1",
      credential: {
        source: { kind: "reference", id: "acct" },
        placement: { kind: "env-reference", envVar: "TEST_KEY" },
      },
    },
    models: { fallbackIds: ["m1"] },
    ...overrides,
  };
}

async function config(): Promise<Record<string, unknown>> {
  return parseTomlText(await readFile(join(dir, "config.toml"), "utf8"), "config.toml");
}

describe("Codex adapter", () => {
  it("writes a provider table and default model", async () => {
    const plan = await kit.resolveAndPlan(request());
    expect(plan.preview.blockers).toEqual([]);
    expect((await kit.apply(plan)).status).toBe("applied");

    const parsed = await config();
    expect(parsed.model_provider).toBe("company");
    expect(parsed.model).toBe("m1");
    const providers = parsed.model_providers as Record<string, Record<string, unknown>>;
    expect(providers.company).toMatchObject({
      base_url: "https://api.example.com/v1",
      env_key: "TEST_KEY",
      wire_api: "responses",
      requires_openai_auth: false,
    });

    expect((await kit.apply(await kit.resolveAndPlan(request()))).status).toBe("unchanged");
  });

  it("preserves comments in an existing config", async () => {
    await writeFile(
      join(dir, "config.toml"),
      '# my config\nmodel = "old" # keep\n',
      "utf8",
    );
    await kit.apply(await kit.resolveAndPlan(request()));
    const text = await readFile(join(dir, "config.toml"), "utf8");
    expect(text).toContain("# my config");
    expect(text).toContain("model = \"m1\" # keep");
  });

  it("requires adoption for an existing unowned provider", async () => {
    await writeFile(
      join(dir, "config.toml"),
      '[model_providers.company]\nbase_url = "https://old.example"\n',
      "utf8",
    );
    const blocked = await kit.resolveAndPlan(request());
    expect(blocked.preview.blockers).toContainEqual(
      expect.objectContaining({ code: "OWNERSHIP_CONFLICT" }),
    );
    expect((await kit.apply(blocked)).status).toBe("failed");

    const adopted = await kit.resolveAndPlan(
      request({ ownership: { adopt: ["company"] } }),
    );
    expect((await kit.apply(adopted)).status).toBe("applied");
    const parsed = await config();
    const providers = parsed.model_providers as Record<string, Record<string, unknown>>;
    expect(providers.company?.base_url).toBe("https://api.example.com/v1");
  });

  it("rejects unsupported protocols and credential placements", async () => {
    await expect(
      kit.resolveAndPlan(
        request({
          provider: {
            ...request().provider!,
            protocol: "openai-completions",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });

    await expect(
      kit.resolveAndPlan(
        request({
          provider: {
            ...request().provider!,
            credential: {
              source: { kind: "reference", id: "acct" },
              placement: { kind: "external-env", envVar: "TEST_KEY" },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INTENT" });
  });

  it("reports a project config as a possible override", async () => {
    const projectDir = join(dir, "project");
    await mkdir(join(projectDir, ".codex"), { recursive: true });
    await writeFile(join(projectDir, ".codex", "config.toml"), "model = \"x\"\n", "utf8");
    const plan = await kit.resolveAndPlan(request({ target: { configDir: dir, projectDir } }));
    expect(plan.preview.effectiveness.level).toBe("may-be-overridden");
  });

  it("removes an owned provider and clears its default selection", async () => {
    await kit.apply(await kit.resolveAndPlan(request()));
    const removal = await kit.resolveAndPlan({
      agent: "codex",
      target: { configDir: dir },
      lifecycle: { removeProviders: ["company"] },
    });
    expect(removal.preview.warnings).toContainEqual(
      expect.objectContaining({ code: "CODEX_DEFAULT_MODEL_REMOVED" }),
    );
    expect((await kit.apply(removal)).status).toBe("applied");
    const parsed = await config();
    expect(parsed.model_providers).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.model_provider).toBeUndefined();
  });
});