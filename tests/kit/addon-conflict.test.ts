import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultModel } from "../../src/addons/default-model.js";
import { createConfigKit } from "../../src/kit.js";
import type { ConfigKit, ResolveAndPlanRequest } from "../../src/types.js";

let dir: string;
let kit: ConfigKit;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "config-kit-addon-"));
  kit = createConfigKit({
    ownerId: "owner",
    resolveCredential: () => "secret",
    addons: [
      defaultModel({ modelId: "a" }),
      defaultModel({ modelId: "b" }),
    ],
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("rejects two add-ons that set the same semantic target", async () => {
  const request: ResolveAndPlanRequest = {
    agent: "pi",
    target: {
      configDir: dir,
      launchEnvironment: { PI_CODING_AGENT_DIR: dir, TEST_KEY: "x" },
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
      overrides: { m1: { contextWindow: 1, maxOutputTokens: 1 } },
    },
  };
  await expect(kit.resolveAndPlan(request)).rejects.toMatchObject({
    code: "ADDON_CONFLICT",
  });
});
