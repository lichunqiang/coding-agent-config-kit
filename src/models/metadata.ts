import type { Catalog } from "@opencode-ai/models";

import { ConfigKitError } from "../errors.js";
import type { MetadataSource } from "../types.js";

export interface MetadataCatalog extends Catalog {
  source: MetadataSource;
  /** Snapshot generation time, when the data came from the packaged snapshot. */
  generatedAt?: string;
  /** Request time, when the data came from the live API. */
  fetchedAt?: string;
  /** Set when live retrieval failed and the snapshot was used instead. */
  fallbackReason?: string;
}

export interface LoadMetadataOptions {
  source?: MetadataSource;
  timeoutMs?: number;
  now?: () => number;
  forceRefresh?: boolean;
}

const LIVE_CACHE_TTL_MS = 5 * 60_000;

let liveCache: { at: number; catalog: Catalog } | undefined;

/**
 * Load the models.dev catalog.
 *
 * The packaged snapshot is the default and never performs a network request.
 * Live retrieval only happens when explicitly requested and falls back to the
 * snapshot with `fallbackReason` set.
 */
export async function loadMetadata(
  options: LoadMetadataOptions = {},
): Promise<MetadataCatalog> {
  const source = options.source ?? "snapshot";
  const now = options.now ?? Date.now;

  if (source === "live") {
    if (
      !options.forceRefresh &&
      liveCache !== undefined &&
      now() - liveCache.at < LIVE_CACHE_TTL_MS
    ) {
      return {
        ...liveCache.catalog,
        source: "live",
        fetchedAt: new Date(liveCache.at).toISOString(),
      };
    }

    try {
      const { Models } = await import("@opencode-ai/models");
      const client = Models.make();
      const catalog = await client.catalog({
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      liveCache = { at: now(), catalog };
      return {
        ...catalog,
        source: "live",
        fetchedAt: new Date(now()).toISOString(),
      };
    } catch (error) {
      const snapshot = await loadSnapshot();
      return {
        ...snapshot,
        fallbackReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return loadSnapshot();
}

async function loadSnapshot(): Promise<MetadataCatalog> {
  try {
    const snapshot = await import("@opencode-ai/models/snapshot");
    return {
      providers: snapshot.providers,
      models: snapshot.models,
      source: "snapshot",
      generatedAt: snapshot.generatedAt,
    };
  } catch (error) {
    throw new ConfigKitError({
      code: "MODEL_DISCOVERY_FAILED",
      message: "Unable to load the packaged models.dev snapshot",
      phase: "resolve",
      cause: error,
    });
  }
}

/** Test helper: forget any cached live catalog. */
export function clearMetadataCache(): void {
  liveCache = undefined;
}

export function isSnapshotStale(
  catalog: MetadataCatalog,
  maxAgeMs: number = 24 * 60 * 60_000,
  now: number = Date.now(),
): boolean {
  if (catalog.generatedAt === undefined) return false;
  const generatedAt = Date.parse(catalog.generatedAt);
  if (!Number.isFinite(generatedAt)) return false;
  return now - generatedAt > maxAgeMs;
}