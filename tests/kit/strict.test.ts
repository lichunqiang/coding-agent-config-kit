import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConfigKit } from "../../src/kit.js";
import type { ConfigKit, ResolveAndPlanRequest } from "../../src/types.js";

let dir: string;
let kit: ConfigKit;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "config-kit-strict-"));
  kit = createConfigKit({
    ownerId: "owner",
    resolveCredential: () => "secret",
    lock: { timeoutMs: 300 },
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function baseRequest(): ResolveAndPlanRequest {
  return {
    agent: "pi",
    target: {
      configDir: dir,
      launchEnvironment: { PI_CODING_AGENT_DIR: dir, TEST_KEY: "present" },
    },
    provider: {
      id: "company",
      protocol: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com",
      credential: {
        source: { kind: "reference", id: "acct" },
        placement: { kind: "env-reference", envVar: "TEST_KEY" },
      },
    },
    models: {
      fallbackIds: ["m1"],
      overrides: { m1: { contextWindow: 64_000, maxOutputTokens: 8_000 } },
    },
  };
}

async function models(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(dir, "models.json"), "utf8")) as Record<string, any>;
}

describe("strict sync", () => {
  it("requires confirmDeletions and then removes owned models", async () => {
    await kit.apply(await kit.resolveAndPlan(baseRequest()));
    expect((await models()).providers.company.models.map((m: any) => m.id)).toEqual(["m1"]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            models: [{ name: "models/m2", displayName: "M2", inputTokenLimit: 128_000, outputTokenLimit: 16_000 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const strict = await kit.resolveAndPlan({
      ...baseRequest(),
      models: {
        discovery: {},
        sync: "strict",
        overrides: { m2: { contextWindow: 128_000, maxOutputTokens: 16_000 } },
      },
    });
    expect(strict.preview.blockers).toEqual([]);
    expect(strict.preview.discovery.completeness).toBe("complete");

    const blocked = await kit.apply(strict);
    expect(blocked.status).toBe("failed");
    expect(blocked.error?.code).toBe("STRICT_SYNC_UNPROVEN");

    const confirmed = await kit.apply(strict, { confirmDeletions: true });
    expect(confirmed.status).toBe("applied");
    expect((await models()).providers.company.models.map((m: any) => m.id)).toEqual(["m2"]);
  });

  it("removes models through the lifecycle API", async () => {
    await kit.apply(await kit.resolveAndPlan(baseRequest()));
    const removal = await kit.resolveAndPlan({
      agent: "pi",
      target: { configDir: dir },
      lifecycle: { removeModels: { company: ["m1"] } },
    });
    expect((await kit.apply(removal)).status).toBe("applied");
    expect((await models()).providers.company.models).toEqual([]);
  });
});