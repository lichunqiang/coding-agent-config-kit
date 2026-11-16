import { describe, expect, it } from "vitest";

import type { MetadataCatalog } from "../../src/models/metadata.js";
import { resolveModels } from "../../src/models/resolve.js";
import type { CapabilityName } from "../../src/types.js";

const allProjectable: ReadonlySet<CapabilityName> = new Set([
  "contextWindow",
  "maxOutputTokens",
  "reasoning",
  "reasoningEfforts",
  "inputModalities",
  "toolCalling",
]);

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "same",
    name: "Same Model",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high", null] }],
    tool_call: true,
    modalities: { input: ["text", "pdf"], output: ["text"] },
    limit: { context: 1000, output: 500 },
    ...overrides,
  };
}

function catalog(): MetadataCatalog {
  return {
    providers: {
      a: { id: "a", name: "A", models: { same: model() } },
      b: { id: "b", name: "B", models: { same: model() } },
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        models: { "deepseek-chat": model({ id: "deepseek-chat" }) },
      },
    },
    models: {},
    source: "snapshot",
    generatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as MetadataCatalog;
}

describe("resolveModels", () => {
  it("applies field-level precedence: user > provider > models.dev", () => {
    const result = resolveModels({
      agent: "pi",
      entries: [
        {
          requestId: "m1",
          displayName: "M1",
          capabilities: { reasoning: false },
        },
      ],
      aliases: { m1: "deepseek/deepseek-chat" },
      metadataProvider: "deepseek",
      overrides: { m1: { contextWindow: 64_000 } },
      catalog: catalog(),
      projectable: allProjectable,
    });

    const caps = result.models[0]!.capabilities;
    expect(caps.contextWindow).toMatchObject({ value: 64_000, source: "user" });
    expect(caps.reasoning).toMatchObject({ value: false, source: "provider" });
    expect(caps.maxOutputTokens).toMatchObject({ value: 500, source: "models.dev" });
    expect(caps.toolCalling).toMatchObject({ value: true, source: "models.dev" });
    expect(caps.reasoningEfforts).toMatchObject({
      value: ["low", "high"],
      source: "models.dev",
    });
    expect(result.models[0]!.metadataId).toBe("deepseek/deepseek-chat");
    expect(result.models[0]!.displayName).toBe("M1");
  });

  it("does not guess when several providers expose the same model ID", () => {
    const result = resolveModels({
      agent: "pi",
      entries: [{ requestId: "same" }],
      catalog: catalog(),
      projectable: allProjectable,
    });
    expect(result.models[0]!.metadataId).toBeUndefined();
    expect(result.models[0]!.capabilities.toolCalling).toBeUndefined();
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "MODEL_METADATA_AMBIGUOUS" }),
    );
  });

  it("warns when an alias cannot be resolved", () => {
    const result = resolveModels({
      agent: "pi",
      entries: [{ requestId: "missing" }],
      aliases: { missing: "deepseek/nope" },
      catalog: catalog(),
      projectable: allProjectable,
    });
    expect(result.models[0]!.metadataId).toBeUndefined();
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "MODEL_METADATA_UNRESOLVED" }),
    );
  });

  it("marks fields the target cannot express as not-projectable", () => {
    const projectable = new Set<CapabilityName>(allProjectable);
    projectable.delete("inputModalities");
    const result = resolveModels({
      agent: "pi",
      entries: [{ requestId: "m1" }],
      aliases: { m1: "deepseek/deepseek-chat" },
      catalog: catalog(),
      projectable,
    });
    expect(result.models[0]!.notProjectable).toContain("inputModalities");
    expect(result.models[0]!.capabilities.inputModalities).toBeDefined();
  });

  it("ignores models.dev entirely in ignore mode", () => {
    const result = resolveModels({
      agent: "pi",
      entries: [{ requestId: "m1", capabilities: { contextWindow: 100 } }],
      aliases: { m1: "deepseek/deepseek-chat" },
      metadataMode: "ignore",
      catalog: catalog(),
      projectable: allProjectable,
    });
    expect(result.models[0]!.capabilities.contextWindow).toMatchObject({
      value: 100,
      source: "provider",
    });
    expect(result.models[0]!.capabilities.toolCalling).toBeUndefined();
    expect(result.models[0]!.metadataId).toBeUndefined();
  });

  it("warns about Pi defaults when capability fields are unknown", () => {
    const result = resolveModels({
      agent: "pi",
      entries: [{ requestId: "m1" }],
      projectable: allProjectable,
      agentDefaults: { contextWindow: 128_000, maxOutputTokens: 16_384 },
    });
    expect(result.warnings.filter((item) => item.code === "CAPABILITY_UNKNOWN")).toHaveLength(2);
    expect(result.blockers).toHaveLength(0);
  });

  it("can block on unknown required capabilities", () => {
    const result = resolveModels({
      agent: "pi",
      entries: [{ requestId: "m1" }],
      projectable: allProjectable,
      agentDefaults: { contextWindow: 128_000 },
      unknownPolicy: "block",
    });
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "CAPABILITY_UNKNOWN", severity: "error" }),
    );
  });

  it("uses fallback IDs only when discovery produced nothing", () => {
    const result = resolveModels({
      agent: "pi",
      entries: null,
      fallbackIds: ["x"],
      projectable: allProjectable,
    });
    expect(result.models).toHaveLength(1);
    expect(result.models[0]!.requestId).toBe("x");
  });

  it("fails without discovery results or fallback IDs", () => {
    expect(() =>
      resolveModels({
        agent: "pi",
        entries: null,
        projectable: allProjectable,
      }),
    ).toThrowError(expect.objectContaining({ code: "MODEL_DISCOVERY_FAILED" }));
  });
});