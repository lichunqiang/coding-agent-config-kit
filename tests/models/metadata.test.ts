import { describe, expect, it } from "vitest";

import {
  isSnapshotStale,
  loadMetadata,
  type MetadataCatalog,
} from "../../src/models/metadata.js";

describe("metadata loading", () => {
  it("loads the packaged snapshot without network access", async () => {
    const catalog = await loadMetadata();
    expect(catalog.source).toBe("snapshot");
    expect(typeof catalog.generatedAt).toBe("string");
    expect(Object.keys(catalog.providers).length).toBeGreaterThan(100);
    expect(catalog.providers.anthropic).toBeDefined();
  });

  it("treats snapshots older than 24h as stale", () => {
    const fresh: MetadataCatalog = {
      providers: {},
      models: {},
      source: "snapshot",
      generatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    };
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    expect(isSnapshotStale(fresh, undefined, now)).toBe(false);
    expect(isSnapshotStale(fresh, undefined, now + 24 * 60 * 60_000)).toBe(true);
  });
});