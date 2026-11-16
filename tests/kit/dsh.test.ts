import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { defaultModel } from "../../src/addons/default-model.js";
import { createConfigKit } from "../../src/kit.js";
import type { ConfigKit, ResolveAndPlanRequest } from "../../src/types.js";

let home: string;
let profileDir: string;
let kit: ConfigKit;

const PATCH = `# keep this comment
- id: llm-pi-ai
  config:
    providers: {}
- id: agent-default-model
  config:
    provider: ""
    model: ""
`;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "config-kit-dsh-"));
  profileDir = join(home, "profiles", "desktop");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "cordis.patch.yml"), PATCH, "utf8");
  kit = createConfigKit({
    ownerId: "owner",
    resolveCredential: () => "secret",
    addons: [defaultModel({ modelId: "m1" })],
    lock: { timeoutMs: 300 },
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function request(overrides: Partial<ResolveAndPlanRequest> = {}): ResolveAndPlanRequest {
  return {
    agent: "deepseek-harness",
    target: {
      profile: "desktop",
      launchEnvironment: { DSH_HOME: home, TEST_KEY: "present" },
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
    models: {
      fallbackIds: ["m1"],
      overrides: { m1: { contextWindow: 64_000, maxOutputTokens: 8_000 } },
    },
    ...overrides,
  };
}

async function patchData(): Promise<Array<Record<string, any>>> {
  return parseYaml(await readFile(join(profileDir, "cordis.patch.yml"), "utf8")) as Array<
    Record<string, any>
  >;
}

function providerContainer(data: Array<Record<string, any>>): Record<string, any> {
  return data.find((item) => item.id === "llm-pi-ai")!.config.providers;
}

describe("DeepSeek Harness adapter", () => {
  it("writes a provider route and default model into the profile patch", async () => {
    const plan = await kit.resolveAndPlan(request());
    expect(plan.preview.blockers).toEqual([]);
    expect((await kit.apply(plan)).status).toBe("applied");

    const text = await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
    expect(text).toContain("# keep this comment");

    const data = await patchData();
    const provider = providerContainer(data).company;
    expect(provider).toMatchObject({
      apiKey: "TEST_KEY",
      api: "openai-responses",
      baseURL: "https://api.example.com/v1",
    });
    expect(provider.models[0]).toMatchObject({
      id: "m1",
      contextWindow: 64_000,
      maxTokens: 8_000,
    });
    const defaultModelItem = data.find((item) => item.id === "agent-default-model")!;
    expect(defaultModelItem.config.provider).toBe("company");
    expect(defaultModelItem.config.model).toBe("m1");

    expect((await kit.apply(await kit.resolveAndPlan(request()))).status).toBe("unchanged");
  });

  it("requires adoption for an existing unowned route", async () => {
    const data = await patchData();
    providerContainer(data).company = { baseURL: "https://old.example" };
    await writeFile(join(profileDir, "cordis.patch.yml"), JSON.stringify(data), "utf8");

    const blocked = await kit.resolveAndPlan(request());
    expect(blocked.preview.blockers).toContainEqual(
      expect.objectContaining({ code: "OWNERSHIP_CONFLICT" }),
    );
    expect((await kit.apply(blocked)).status).toBe("failed");

    const adopted = await kit.resolveAndPlan(
      request({ ownership: { adopt: ["company"] } }),
    );
    expect((await kit.apply(adopted)).status).toBe("applied");
  });

  it("removes an owned route", async () => {
    await kit.apply(await kit.resolveAndPlan(request()));
    const removal = await kit.resolveAndPlan({
      agent: "deepseek-harness",
      target: {
        profile: "desktop",
        launchEnvironment: { DSH_HOME: home },
      },
      lifecycle: { removeProviders: ["company"] },
    });
    expect((await kit.apply(removal)).status).toBe("applied");
    const data = await patchData();
    expect(providerContainer(data).company).toBeUndefined();
  });

  it("reports unobservable --patch overlays", async () => {
    const plan = await kit.resolveAndPlan(request());
    expect(plan.preview.effectiveness.level).toBe("unknown");
  });
});