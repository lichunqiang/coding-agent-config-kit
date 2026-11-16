import { ConfigKitError } from "../errors.js";
import type {
  AgentId,
  CapabilityName,
  CapabilitySource,
  Diagnostic,
  ModelCapabilities,
  ModelCapabilityOverrides,
  ModelMetadataMode,
  NormalizedModelEntry,
  ResolvedModel,
  Sourced,
} from "../types.js";
import type { MetadataCatalog } from "./metadata.js";

const CAPABILITY_NAMES: CapabilityName[] = [
  "contextWindow",
  "maxOutputTokens",
  "reasoning",
  "reasoningEfforts",
  "inputModalities",
  "toolCalling",
];

export interface ResolveModelsOptions {
  agent: AgentId;
  entries: NormalizedModelEntry[] | null;
  fallbackIds?: string[];
  usedFallback?: boolean;
  aliases?: Record<string, string>;
  metadataProvider?: string;
  metadataMode?: ModelMetadataMode;
  overrides?: Record<string, ModelCapabilityOverrides>;
  catalog?: MetadataCatalog;
  projectable: ReadonlySet<CapabilityName>;
  /** Agent defaults that will silently apply when a capability is unknown. */
  agentDefaults?: Partial<Record<CapabilityName, unknown>>;
  unknownPolicy?: "warn" | "block";
}

export interface ResolveModelsResult {
  models: ResolvedModel[];
  warnings: Diagnostic[];
  blockers: Diagnostic[];
}

export function resolveModels(options: ResolveModelsOptions): ResolveModelsResult {
  const warnings: Diagnostic[] = [];
  const blockers: Diagnostic[] = [];
  const metadataMode = options.metadataMode ?? "write";
  const catalog = metadataMode === "ignore" ? undefined : options.catalog;

  let candidates: NormalizedModelEntry[];
  if (options.entries !== null && options.entries.length > 0) {
    candidates = options.entries;
  } else {
    candidates = (options.fallbackIds ?? []).map((id) => ({ requestId: id }));
    if (candidates.length === 0) {
      throw new ConfigKitError({
        code: "MODEL_DISCOVERY_FAILED",
        message: "No models were discovered and no fallback IDs were provided",
        agent: options.agent,
        phase: "resolve",
        replanRequired: true,
      });
    }
  }

  const models = candidates.map((entry) => {
    const alias = options.aliases?.[entry.requestId];
    const lookup =
      catalog === undefined
        ? { kind: "none" as const }
        : findMetadata(catalog, entry.requestId, alias, options.metadataProvider);
    const match = lookup.kind === "found" ? lookup.match : null;

    if (lookup.kind === "ambiguous") {
      warnings.push({
        code: "MODEL_METADATA_AMBIGUOUS",
        severity: "warning",
        message: `Multiple models.dev candidates for ${entry.requestId}; not guessing`,
        field: entry.requestId,
      });
    } else if (
      catalog !== undefined &&
      lookup.kind === "none" &&
      (alias !== undefined || options.metadataProvider !== undefined)
    ) {
      warnings.push({
        code: "MODEL_METADATA_UNRESOLVED",
        severity: "warning",
        message: `No unique models.dev match for ${entry.requestId}`,
        field: entry.requestId,
      });
    }

    const capabilities = mergeCapabilities({
      overrides: options.overrides?.[entry.requestId],
      provider: entry.capabilities,
      metadata: match?.model,
      metadataAsOf: catalog?.generatedAt ?? catalog?.fetchedAt,
      metadataMode,
    });

    const notProjectable = CAPABILITY_NAMES.filter(
      (name) => capabilities[name] !== undefined && !options.projectable.has(name),
    );

    const missingDefaults = Object.entries(options.agentDefaults ?? {}).filter(
      ([name, value]) =>
        capabilities[name as CapabilityName] === undefined && value !== undefined,
    );
    for (const [name, value] of missingDefaults) {
      const diagnostic: Diagnostic = {
        code: "CAPABILITY_UNKNOWN",
        severity: options.unknownPolicy === "block" ? "error" : "warning",
        message: `${name} is unknown; the agent will use its default value (${String(value)})`,
        field: name,
      };
      if (options.unknownPolicy === "block") blockers.push(diagnostic);
      else warnings.push(diagnostic);
    }

    const model: ResolvedModel = {
      requestId: entry.requestId,
      displayName: entry.displayName ?? match?.model.name ?? entry.requestId,
      capabilities,
      notProjectable,
    };
    if (match !== null) model.metadataId = match.id;
    return model;
  });

  return { models, warnings, blockers };
}

interface MetadataModelLike {
  name?: string;
  canonical_model_id?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values?: Array<string | null> }>;
  tool_call?: boolean;
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
}

interface MetadataMatch {
  id: string;
  model: MetadataModelLike;
}

type MetadataLookup =
  | { kind: "found"; match: MetadataMatch }
  | { kind: "ambiguous" }
  | { kind: "none" };

function findMetadata(
  catalog: MetadataCatalog,
  requestId: string,
  alias: string | undefined,
  providerHint: string | undefined,
): MetadataLookup {
  if (alias !== undefined) {
    if (catalog.models[alias] !== undefined) {
      return {
        kind: "found",
        match: { id: alias, model: catalog.models[alias] as MetadataModelLike },
      };
    }
    const slash = alias.indexOf("/");
    if (slash > 0) {
      const providerKey = alias.slice(0, slash);
      const modelKey = alias.slice(slash + 1);
      const provider = catalog.providers[providerKey];
      const model = provider?.models[modelKey] as MetadataModelLike | undefined;
      if (model !== undefined) {
        return { kind: "found", match: { id: alias, model } };
      }
    }
    if (providerHint !== undefined) {
      const model = catalog.providers[providerHint]?.models[alias] as MetadataModelLike | undefined;
      if (model !== undefined) {
        return {
          kind: "found",
          match: { id: canonicalId(alias, model, providerHint), model },
        };
      }
    }
  }

  if (providerHint !== undefined) {
    const model = catalog.providers[providerHint]?.models[requestId] as MetadataModelLike | undefined;
    if (model !== undefined) {
      return {
        kind: "found",
        match: { id: canonicalId(requestId, model, providerHint), model },
      };
    }
  }

  // A global match is only safe when exactly one provider-scoped model has this ID.
  const globalMatches: MetadataMatch[] = [];
  for (const [providerKey, provider] of Object.entries(catalog.providers)) {
    const model = provider.models[requestId] as MetadataModelLike | undefined;
    if (model !== undefined) {
      globalMatches.push({ id: canonicalId(requestId, model, providerKey), model });
    }
  }
  if (globalMatches.length === 1) {
    return { kind: "found", match: globalMatches[0]! };
  }
  if (globalMatches.length > 1) return { kind: "ambiguous" };
  if (catalog.models[requestId] !== undefined) {
    return {
      kind: "found",
      match: { id: requestId, model: catalog.models[requestId] as MetadataModelLike },
    };
  }
  return { kind: "none" };
}

function canonicalId(requestId: string, model: MetadataModelLike, providerKey: string): string {
  return model.canonical_model_id ?? `${providerKey}/${requestId}`;
}

function mergeCapabilities(input: {
  overrides: ModelCapabilityOverrides | undefined;
  provider: ModelCapabilityOverrides | undefined;
  metadata: MetadataModelLike | undefined;
  metadataAsOf: string | undefined;
  metadataMode: ModelMetadataMode;
}): ModelCapabilities {
  const out: ModelCapabilities = {};

  const fromMetadata = input.metadata === undefined ? undefined : metadataCapabilities(input.metadata);
  const override = input.overrides ?? {};
  const provider = input.provider ?? {};

  for (const name of CAPABILITY_NAMES) {
    const user = override[name];
    if (user !== undefined) {
      setCapability(out, name, user, "user");
      continue;
    }
    const providerValue = provider[name];
    if (providerValue !== undefined) {
      setCapability(out, name, providerValue, "provider");
      continue;
    }
    const metadataValue = fromMetadata?.[name];
    if (metadataValue !== undefined && input.metadataMode !== "ignore") {
      setCapability(
        out,
        name,
        metadataValue.value,
        "models.dev",
        input.metadataAsOf,
      );
    }
  }
  return out;
}

function metadataCapabilities(model: MetadataModelLike): Partial<ModelCapabilities> {
  const caps: Partial<ModelCapabilities> = {};
  if (typeof model.limit?.context === "number") {
    caps.contextWindow = { value: model.limit.context, source: "models.dev" };
  }
  if (typeof model.limit?.output === "number") {
    caps.maxOutputTokens = { value: model.limit.output, source: "models.dev" };
  }
  if (typeof model.reasoning === "boolean") {
    caps.reasoning = { value: model.reasoning, source: "models.dev" };
  }
  if (Array.isArray(model.modalities?.input)) {
    caps.inputModalities = { value: model.modalities.input, source: "models.dev" };
  }
  if (typeof model.tool_call === "boolean") {
    caps.toolCalling = { value: model.tool_call, source: "models.dev" };
  }
  const efforts = (model.reasoning_options ?? []).flatMap((option) =>
    option.type === "effort"
      ? (option.values ?? [])
          .filter((value): value is string => typeof value === "string")
          .map((value) => String(value))
      : [],
  );
  if (efforts.length > 0) caps.reasoningEfforts = { value: efforts, source: "models.dev" };
  return caps;
}

function setCapability<K extends CapabilityName>(
  out: ModelCapabilities,
  name: K,
  value: unknown,
  source: CapabilitySource,
  asOf?: string,
): void {
  const entry: Sourced<unknown> = { value, source };
  if (asOf !== undefined) entry.asOf = asOf;
  (out as Record<CapabilityName, Sourced<unknown>>)[name] = entry;
}