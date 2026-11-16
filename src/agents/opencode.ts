import { fileExists, readFileIfExists } from "../internal/fs.js";
import { stableStringify } from "../internal/hash.js";
import { emptyManagementRecord, type ManagementRecord } from "../internal/state.js";
import type {
  CapabilityName,
  Diagnostic,
  EffectivenessLayer,
  IntentPreview,
  ModelMetadataMode,
  Protocol,
  ResolvedModel,
  SemanticIntent,
} from "../types.js";
import {
  asJsonObject,
  deleteJsonPath,
  getJsonPath,
  parseJsonText,
  setJsonPath,
} from "../editing/json.js";
import type { AgentAdapter, AgentBuildInput, AgentPlan, PlannedFile } from "./types.js";

const PACKAGE_BY_PROTOCOL: Record<Protocol, string> = {
  "openai-completions": "@ai-sdk/openai-compatible",
  "openai-responses": "@ai-sdk/openai",
  "anthropic-messages": "@ai-sdk/anthropic",
  "google-generative-ai": "@ai-sdk/google",
};

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  protocols: [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
  ],
  placements: ["env-reference"],
  supportsDefaultSlots: false,
  projectable: new Set<CapabilityName>([
    "contextWindow",
    "maxOutputTokens",
    "reasoning",
    "reasoningEfforts",
    "inputModalities",
    "toolCalling",
  ]),
  async buildPlan(input: AgentBuildInput): Promise<AgentPlan> {
    const warnings: Diagnostic[] = [];
    const blockers: Diagnostic[] = [];
    const configPath = input.resolved.files[0];
    if (configPath === undefined) throw new Error("OpenCode target has no config file");

    const before = await readText(configPath);
    const root = asJsonObject(parseJsonText(before ?? "", configPath), configPath);
    const format = detectFormat(root, input);
    if (format === "v1") {
      blockers.push({
        code: "TARGET_VERSION_CONFLICT",
        severity: "error",
        message:
          "OpenCode V1 (provider) config is not supported by this build; migrate to V2 providers",
        path: configPath,
      });
    }
    if (format === "both") {
      blockers.push({
        code: "TARGET_VERSION_CONFLICT",
        severity: "error",
        message: "openCode config contains both provider and providers; refusing to guess",
        path: configPath,
      });
    }

    const state =
      input.state ?? emptyManagementRecord(input.ownerId, "opencode", input.resolved.configDir);
    const nextState = cloneState(state);
    const provider = input.provider;
    const providerId = provider?.id;
    const adopt = new Set(input.ownership.adopt ?? []);
    const intents: IntentPreview[] = [];
    const redactions: string[] = [];
    let after = before ?? "";
    const usable = format === "v2";

    if (provider !== undefined && providerId !== undefined && usable) {
      const providersValue = getJsonPath(root, ["providers"]);
      const providers =
        providersValue === undefined ? {} : asJsonObject(providersValue, configPath);
      const existing = providers[providerId];
      const stateKey = `provider:${providerId}`;
      const owned = state.entries[stateKey] !== undefined;

      if (existing !== undefined && !owned && !adopt.has(providerId)) {
        blockers.push({
          code: "OWNERSHIP_CONFLICT",
          severity: "error",
          message: `OpenCode provider "${providerId}" already exists and is not managed by this owner`,
          field: `providers.${providerId}`,
        });
      } else {
        const placement = provider.credential.placement;
        if (placement.kind !== "env-reference") {
          blockers.push({
            code: "UNSUPPORTED_INTENT",
            severity: "error",
            message: "OpenCode providers require env-reference credentials (env list)",
          });
        } else {
          const existingObject =
            existing !== undefined && isRecord(existing) ? existing : {};
          const nextProvider: Record<string, unknown> = {
            ...existingObject,
            name: provider.displayName ?? providerId,
            env: [placement.envVar],
            package: PACKAGE_BY_PROTOCOL[provider.protocol],
            models: mergeModels({
              existing: isRecord(existingObject.models) ? existingObject.models : {},
              models: input.models,
              metadataMode: input.metadataMode,
              strict: input.strict,
              confirmDeletions: input.confirmDeletions,
              completeness: input.discoveryCompleteness,
              usedFallback: input.usedFallback,
              warnings,
            }),
          };
          after = setJsonPath(after, ["providers", providerId], nextProvider);
          nextState.entries[stateKey] = {
            kind: "provider",
            fields: ["name", "env", "package", "models"],
            baseline: {
              baseUrl: provider.baseUrl,
              envVar: placement.envVar,
              modelIds: input.models.map((model) => model.requestId),
            },
          };
          intents.push({
            kind: "registerProvider",
            summary: `Register OpenCode provider ${providerId} (${provider.protocol})`,
          });
          warnings.push({
            code: "OPENCODE_PACKAGE_ASSUMED",
            severity: "warning",
            message: `Assumed package ${PACKAGE_BY_PROTOCOL[provider.protocol]} for ${provider.protocol}`,
          });
        }
      }
    }

    const defaultIntent = [...input.intents]
      .reverse()
      .find(
        (intent): intent is Extract<SemanticIntent, { kind: "setDefaultModel" }> =>
          intent.kind === "setDefaultModel",
      );
    if (defaultIntent !== undefined && usable) {
      const existingDefault = readDefaultModel(root);
      const targetProvider = providerId ?? existingDefault.split("/")[0];
      if (targetProvider === undefined || targetProvider === "") {
        blockers.push({
          code: "UNSUPPORTED_INTENT",
          severity: "error",
          message: "setDefaultModel requires a provider in the same plan",
        });
      } else {
        after = setJsonPath(after, ["model"], `${targetProvider}/${defaultIntent.modelId}`);
        intents.push({
          kind: "setDefaultModel",
          summary: `Set OpenCode default to ${targetProvider}/${defaultIntent.modelId}`,
        });
      }
    }

    if (input.intents.some((intent) => intent.kind === "unsetDefaultModel") && usable) {
      after = deleteJsonPath(after, ["model"]);
      intents.push({ kind: "unsetDefaultModel", summary: "Remove OpenCode default model" });
    }

    for (const removeId of input.lifecycle.removeProviders ?? []) {
      const stateKey = `provider:${removeId}`;
      if (state.entries[stateKey] === undefined) {
        blockers.push({
          code: "OWNERSHIP_CONFLICT",
          severity: "error",
          message: `Cannot remove unmanaged OpenCode provider "${removeId}"`,
        });
        continue;
      }
      if (removeId === providerId) {
        blockers.push({
          code: "ADDON_CONFLICT",
          severity: "error",
          message: `Cannot register and remove provider "${removeId}" in one plan`,
        });
        continue;
      }
      after = deleteJsonPath(after, ["providers", removeId]);
      delete nextState.entries[stateKey];
      const currentDefault = readDefaultModel(root);
      if (currentDefault.startsWith(`${removeId}/`)) {
        after = deleteJsonPath(after, ["model"]);
        warnings.push({
          code: "OPENCODE_DEFAULT_MODEL_REMOVED",
          severity: "warning",
          message: `Removed provider "${removeId}" was the default; default model was cleared`,
        });
      }
      intents.push({ kind: "removeProvider", summary: `Remove OpenCode provider ${removeId}` });
    }

    for (const [removeProviderId, modelIds] of Object.entries(
      input.lifecycle.removeModels ?? {},
    )) {
      const stateKey = `provider:${removeProviderId}`;
      if (state.entries[stateKey] === undefined) {
        blockers.push({
          code: "OWNERSHIP_CONFLICT",
          severity: "error",
          message: `Cannot remove models from unmanaged OpenCode provider "${removeProviderId}"`,
        });
        continue;
      }
      const existing = getJsonPath(root, ["providers", removeProviderId, "models"]);
      if (isRecord(existing)) {
        const kept = { ...existing };
        for (const modelId of modelIds) delete kept[modelId];
        after = setJsonPath(after, ["providers", removeProviderId, "models"], kept);
        intents.push({
          kind: "removeModel",
          summary: `Remove ${modelIds.length} model(s) from ${removeProviderId}`,
        });
      }
    }

    if (before !== null && sameJson(before, after)) after = before;

    const defaultChanged =
      defaultIntent !== undefined ||
      input.intents.some((intent) => intent.kind === "unsetDefaultModel");

    const layers: EffectivenessLayer[] = [
      {
        name: "project opencode.json",
        observed: await pathState(input.resolved.projectSettingsPath),
      },
      { name: "OPENCODE_CONFIG / CLI", observed: "unknown" },
    ];
    const effectiveness: AgentPlan["effectiveness"] =
      layers[0]!.observed === "present"
        ? {
            level: "may-be-overridden",
            reasons: ["A project opencode.json exists and loads after the global config"],
            layers,
          }
        : input.resolved.projectSettingsPath === undefined
          ? {
              level: "unknown",
              reasons: ["projectDir was not provided, so project config cannot be checked"],
              layers,
            }
          : {
              level: "confirmed",
              reasons: ["No project config or CLI override detected"],
              layers,
            };

    const files: PlannedFile[] = [{ path: configPath, before, after, mode: 0o600 }];

    return {
      files,
      intents,
      effects: {
        defaultModelChanged: defaultChanged,
        currentConnectionChanged: defaultIntent !== undefined,
      },
      effectiveness,
      warnings,
      blockers,
      state: nextState,
      adopted: [],
      ownershipConflicts: blockers.some((item) => item.code === "OWNERSHIP_CONFLICT")
        ? [providerId ?? "unknown"]
        : [],
      deletions: [],
      redactions,
    };
  },
};

function detectFormat(
  root: Record<string, unknown>,
  input: AgentBuildInput,
): "v1" | "v2" | "both" {
  const hasV1 = root.provider !== undefined;
  const hasV2 = root.providers !== undefined;
  if (input.target.configFormat === "v1") return hasV2 ? "both" : "v1";
  if (input.target.configFormat === "v2") return hasV1 ? "both" : "v2";
  if (hasV1 && hasV2) return "both";
  if (hasV1) return "v1";
  return "v2";
}

interface MergeModelsInput {
  existing: Record<string, unknown>;
  models: ResolvedModel[];
  metadataMode: ModelMetadataMode;
  strict: boolean;
  confirmDeletions: boolean;
  completeness: "complete" | "partial" | "unknown";
  usedFallback: boolean;
  warnings: Diagnostic[];
}

function mergeModels(input: MergeModelsInput): Record<string, unknown> {
  const next: Record<string, unknown> = { ...input.existing };
  const incoming = new Set(input.models.map((model) => model.requestId));

  for (const model of input.models) {
    const base = isRecord(next[model.requestId]) ? (next[model.requestId] as Record<string, unknown>) : {};
    next[model.requestId] = projectModel(base, model, input.metadataMode, input.warnings);
  }

  if (
    input.strict &&
    input.confirmDeletions &&
    input.completeness === "complete" &&
    !input.usedFallback
  ) {
    for (const id of Object.keys(next)) {
      if (!incoming.has(id)) delete next[id];
    }
  }
  return next;
}

function projectModel(
  base: Record<string, unknown>,
  model: ResolvedModel,
  metadataMode: ModelMetadataMode,
  warnings: Diagnostic[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base, name: model.displayName };
  const caps = model.capabilities;

  const limit: Record<string, number> = isRecord(base.limit) ? { ...base.limit } as Record<string, number> : {};
  writeNumber(limit, "context", caps.contextWindow, metadataMode);
  writeNumber(limit, "output", caps.maxOutputTokens, metadataMode);
  if (Object.keys(limit).length > 0) next.limit = limit;

  const capabilities: Record<string, unknown> = isRecord(base.capabilities)
    ? { ...base.capabilities }
    : {};

  const input = caps.inputModalities;
  if (input !== undefined && writable(input.source, metadataMode)) {
    const filtered = input.value.filter((value) => value === "text" || value === "image");
    if (filtered.length !== input.value.length) {
      warnings.push({
        code: "OPENCODE_MODALITY_DROPPED",
        severity: "warning",
        message: `Dropped modalities OpenCode cannot express for ${model.requestId}`,
        field: model.requestId,
      });
    }
    capabilities.input = filtered;
  }

  const tools = caps.toolCalling;
  if (tools !== undefined && writable(tools.source, metadataMode)) {
    capabilities.tools = tools.value;
  }

  const reasoning = caps.reasoning;
  if (reasoning !== undefined && writable(reasoning.source, metadataMode)) {
    if (reasoning.value === false) {
      capabilities.reasoning = { supported: false };
    } else {
      const efforts = caps.reasoningEfforts;
      capabilities.reasoning =
        efforts !== undefined && writable(efforts.source, metadataMode)
          ? { supported: true, effort: [...efforts.value] }
          : { supported: true };
    }
  }

  if (Object.keys(capabilities).length > 0) next.capabilities = capabilities;
  return next;
}

function writeNumber(
  target: Record<string, number>,
  key: string,
  sourced: { value: number; source: string } | undefined,
  metadataMode: ModelMetadataMode,
): void {
  if (sourced === undefined) return;
  if (!writable(sourced.source, metadataMode)) return;
  target[key] = sourced.value;
}

function writable(source: string, metadataMode: ModelMetadataMode): boolean {
  return source !== "models.dev" || metadataMode === "write";
}

function readDefaultModel(root: Record<string, unknown>): string {
  const value = root.model;
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.providerID === "string" && typeof value.model === "string") {
    return `${value.providerID}/${value.model}`;
  }
  return "";
}

function cloneState(state: ManagementRecord): ManagementRecord {
  return {
    ...state,
    entries: Object.fromEntries(
      Object.entries(state.entries).map(([key, entry]) => [
        key,
        {
          ...entry,
          fields: [...entry.fields],
          ...(entry.baseline === undefined ? {} : { baseline: { ...entry.baseline } }),
        },
      ]),
    ),
  };
}

async function readText(path: string): Promise<string | null> {
  const bytes = await readFileIfExists(path);
  return bytes === null ? null : bytes.toString("utf8");
}

async function pathState(path: string | undefined): Promise<"present" | "absent" | "unknown"> {
  if (path === undefined) return "unknown";
  return (await fileExists(path)) ? "present" : "absent";
}

function sameJson(left: string, right: string): boolean {
  try {
    return (
      stableStringify(parseJsonText(left, "left")) ===
      stableStringify(parseJsonText(right, "right"))
    );
  } catch {
    return left === right;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}