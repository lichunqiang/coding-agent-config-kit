import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearMetadataCache } from "../../src/models/metadata.js";
import { createConfigKit } from "../../src/kit.js";
import type { ConfigKit, ResolveAndPlanRequest } from "../../src/types.js";

let dir: string;
let kit: ConfigKit;

beforeEach(async () => {
  clearMetadataCache();
  dir = await mkdtemp(join(tmpdir(), "config-kit-metadata-"));
  kit = createConfigKit({
    ownerId: "owner",
    resolveCredential: () => "secret",
    lock: { timeoutMs: 300 },
  });
});

afterEach(async () => {
  clearMetadataCache();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function request(source?: "snapshot" | "live"): ResolveAndPlanRequest {
  return {
    agent: "pi",
    target: {
      configDir: dir,
      launchEnvironment: { PI_CODING_AGENT_DIR: dir, TEST_KEY: "present" },
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
      overrides: { m1: { contextWindow: 64_000, maxOutputTokens: 8_000 } },
      ...(source === undefined ? {} : { metadataSource: source }),
    },
  };
}

describe("models.dev data source", () => {
  it("never calls the network for the default snapshot mode", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network should not be used");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const plan = await kit.resolveAndPlan(request());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(plan.preview.metadata.source).toBe("snapshot");
    expect(plan.preview.changes.find((c) => c.path.endsWith("models.json"))?.kind).toBe(
      "create",
    );
  });

  it("falls back to the snapshot when live mode fails, and says so", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const plan = await kit.resolveAndPlan(request("live"));
    expect(fetchSpy).toHaveBeenCalled();
    expect(plan.preview.metadata.source).toBe("snapshot");
    expect(plan.preview.warnings).toContainEqual(
      expect.objectContaining({ code: "METADATA_LIVE_FALLBACK" }),
    );
  });
});
