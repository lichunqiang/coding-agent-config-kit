import { dirname, join } from "node:path";

import { parseDocument } from "yaml";

import { ConfigKitError } from "../errors.js";
import { fileExists, readFileIfExists } from "../internal/fs.js";
import { stableStringify } from "../internal/hash.js";
import {
  emptyManagementRecord,
  type ManagementRecord,
} from "../internal/state.js";
import type {
  CapabilityName,
  Diagnostic,
  EffectivenessLayer,
  IntentPreview,
  ModelCapabilities,
  ModelMetadataMode,
  ResolvedModel,
  SemanticIntent,
} from "../types.js";
import type { AgentAdapter, AgentBuildInput, AgentPlan, PlannedFile } from "./types.js";

type PathPart = string | number;

const PROVIDER_PATH_ANCHOR = "providers";
const DEFAULT_MODEL_ID = "agent-default-model";
const API_KEY_FIELD = "apiKey";

export const dshAdapter: AgentAdapter = {
  id: "deepseek-harness",
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
    "inputModalities",
    "reasoningEfforts",
  ]),
  async buildPlan(input: AgentBuildInput): Promise<AgentPlan> {
    const warnings: Diagnostic[] = [];
    const blockers: Diagnostic[] = [];
    const patchPath = input.resolved.files[0];
    if (patchPath === undefined) throw new Error("DSH target has no patch file");

    const before = await readText(patchPath);
    if (before === null) {
      blockers.push({
        code: "UNSAFE_TARGET",
        severity: "error",
        message: "The DSH profile has no cordis.patch.yml to edit",
        path: patchPath,
      });
    }

    const doc = parseDocument(before ?? "[]\n", { keepSourceTokens: true });
    if (doc.errors.length > 0) {
      throw new ConfigKitError({
        code: "UNPARSEABLE_CONFIG",
        message: `Unable to parse ${patchPath}`,
        phase: "parse",
        path: patchPath,
        details: { errors: doc.errors.map((error) => error.message) },
      });
    }
    const data = doc.toJS() as unknown;
    const items = Array.isArray(data) ? data : [];
    const providerContainer = findProviderContainer(items);
    if (providerContainer === null) {
      blockers.push({
        code: "UNSAFE_TARGET",
        severity: "error",
        message: `No llm-pi-ai providers section found in ${patchPath}`,
        path: patchPath,
      });
    }

    const state =
      input.state ??
      emptyManagementRecord(input.ownerId, "deepseek-harness", input.resolved.configDir);
    const nextState = cloneState(state);
    const provider = input.provider;
    const providerId = provider?.id;
    const adopt = new Set(input.ownership.adopt ?? []);
    const intents: IntentPreview[] = [];
    const deletions: string[] = [];
    const redactions: string[] = [];

    if (provider !== undefined && providerId !== undefined && providerContainer !== null) {
      const existingProviders = providerContainer.value;
      const existing = isRecord(existingProviders) ? existingProviders[providerId] : undefined;
      const stateKey = `provider:${providerId}`;
      const owned = state.entries[stateKey] !== undefined;

      if (existing !== undefined && !owned && !adopt.has(providerId)) {
        blockers.push({
          code: "OWNERSHIP_CONFLICT",
          severity: "error",
          message: `DSH provider "${providerId}" already exists and is not managed by this owner`,
          field: `providers.${providerId}`,
        });
      } else {
        const placement = provider.credential.placement;
        if (placement.kind !== "env-reference") {
          blockers.push({
            code: "UNSUPPORTED_INTENT",
            severity: "error",
            message: "DSH providers require env-reference credentials",
          });
        } else {
          const existingObject = isRecord(existing) ? existing : {};
          const previousModels = Array.isArray(existingObject.models)
            ? existingObject.models
            : [];
          const nextProvider: Record<string, unknown> = {
            ...existingObject,
            displayName: provider.displayName ?? providerId,
            [API_KEY_FIELD]: placement.envVar,
            api: provider.protocol,
            baseURL: provider.baseUrl,
            models: mergeDshModels({
              existing: previousModels,
              models: input.models,
              metadataMode: input.metadataMode,
              strict: input.strict,
              confirmDeletions: input.confirmDeletions,
              completeness: input.discoveryCompleteness,
              usedFallback: input.usedFallback,
              warnings,
              deletions,
            }),
          };
          doc.setIn(
            [...providerContainer.path, providerId],
            nextProvider,
          );
          nextState.entries[stateKey] = {
            kind: "provider",
            fields: [API_KEY_FIELD, "api", "baseURL", "models"],
            baseline: {
              baseUrl: provider.baseUrl,
              modelIds: input.models.map((model) => model.requestId),
            },
          };
          intents.push({
            kind: "registerProvider",
            summary: `Register DSH provider ${providerId} (${provider.protocol})`,
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
    if (defaultIntent !== undefined) {
      const defaultIndex = items.findIndex(
        (item) => isRecord(item) && item.id === DEFAULT_MODEL_ID,
      );
      if (defaultIndex < 0) {
        blockers.push({
          code: "UNSUPPORTED_INTENT",
          severity: "error",
          message: `The profile has no "${DEFAULT_MODEL_ID}" entry to configure`,
        });
      } else {
        const targetProvider = providerId ?? readDefaultProvider(items[defaultIndex]);
        if (targetProvider === undefined) {
          blockers.push({
            code: "UNSUPPORTED_INTENT",
            severity: "error",
            message: "setDefaultModel requires a provider in the same plan",
          });
        } else {
          doc.setIn([defaultIndex, "config", "provider"], targetProvider);
          doc.setIn([defaultIndex, "config", "model"], defaultIntent.modelId);
          intents.push({
            kind: "setDefaultModel",
            summary: `Set DSH default to ${targetProvider}/${defaultIntent.modelId}`,
          });
        }
      }
    }

    if (input.intents.some((intent) => intent.kind === "unsetDefaultModel")) {
      const defaultIndex = items.findIndex(
        (item) => isRecord(item) && item.id === DEFAULT_MODEL_ID,
      );
      if (defaultIndex >= 0) {
        doc.deleteIn([defaultIndex, "config", "provider"]);
        doc.deleteIn([defaultIndex, "config", "model"]);
        intents.push({ kind: "unsetDefaultModel", summary: "Remove DSH default model" });
      }
    }

    for (const removeId of input.lifecycle.removeProviders ?? []) {
      const stateKey = `provider:${removeId}`;
      if (state.entries[stateKey] === undefined) {
        blockers.push({
          code: "OWNERSHIP_CONFLICT",
          severity: "error",
          message: `Cannot remove unmanaged DSH provider "${removeId}"`,
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
      if (providerContainer !== null) {
        doc.deleteIn([...providerContainer.path, removeId]);
      }
      delete nextState.entries[stateKey];
      intents.push({ kind: "removeProvider", summary: `Remove DSH provider ${removeId}` });
    }

    for (const [removeProviderId, modelIds] of Object.entries(
      input.lifecycle.removeModels ?? {},
    )) {
      const stateKey = `provider:${removeProviderId}`;
      if (state.entries[stateKey] === undefined) {
        blockers.push({
          code: "OWNERSHIP_CONFLICT",
          severity: "error",
          message: `Cannot remove models from unmanaged DSH provider "${removeProviderId}"`,
        });
        continue;
      }
      const providerData = providerContainer?.value?.[removeProviderId];
      if (isRecord(providerData) && Array.isArray(providerData.models)) {
        const kept = providerData.models.filter(
          (item) => !(isRecord(item) && typeof item.id === "string" && modelIds.includes(item.id)),
        );
        if (providerContainer !== null) {
          doc.setIn([...providerContainer.path, removeProviderId, "models"], kept);
        }
        intents.push({
          kind: "removeModel",
          summary: `Remove ${modelIds.length} DSH model(s) from ${removeProviderId}`,
        });
      }
    }

    let after = String(doc);
    if (!after.endsWith("\n")) after += "\n";
    if (before !== null && sameYaml(before, after)) after = before;

    const defaultChanged =
      defaultIntent !== undefined ||
      input.intents.some((intent) => intent.kind === "unsetDefaultModel");

    const homePatch = join(dirname(dirname(input.resolved.configDir)), "cordis.patch.yml");
    const homePresent = await fileExists(homePatch);
    const layers: EffectivenessLayer[] = [
      {
        name: "home-level cordis.patch.yml",
        observed: homePresent ? "present" : "absent",
        ...(homePresent ? { note: homePatch } : {}),
      },
      { name: "--patch overlay", observed: "unknown" },
    ];

    const effectiveness: AgentPlan["effectiveness"] = homePresent
      ? {
          level: "may-be-overridden",
          reasons: ["$DSH_HOME/cordis.patch.yml outranks the per-profile layer"],
          layers,
        }
      : {
          level: "unknown",
          reasons: ["--patch overlays are not observable"],
          layers,
        };

    const files: PlannedFile[] = [{ path: patchPath, before, after, mode: 0o600 }];

    return {
      files,
      intents,
      effects: {
        defaultModelChanged: defaultChanged,
        currentConnectionChanged: defaultChanged,
      },
      effectiveness,
      warnings,
      blockers,
      state: nextState,
      adopted: [],
      ownershipConflicts: blockers.some((item) => item.code === "OWNERSHIP_CONFLICT")
        ? [providerId ?? "unknown"]
        : [],
      deletions,
      redactions,
    };
  },
};

interface ProviderContainer {
  path: PathPart[];
  value: Record<string, unknown>;
}

function findProviderContainer(items: unknown[]): ProviderContainer | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isRecord(item) || !isRecord(item.config)) continue;
    const providers = item.config[PROVIDER_PATH_ANCHOR];
    if (isRecord(providers)) {
      return { path: [index, "config", PROVIDER_PATH_ANCHOR], value: providers };
    }
  }
  return null;
}

interface MergeDshModelsInput {
  existing: unknown[];
  models: ResolvedModel[];
  metadataMode: ModelMetadataMode;
  strict: boolean;
  confirmDeletions: boolean;
  completeness: "complete" | "partial" | "unknown";
  usedFallback: boolean;
  warnings: Diagnostic[];
  deletions: string[];
}

function mergeDshModels(input: MergeDshModelsInput): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of input.existing) {
    if (isRecord(item) && typeof item.id === "string") byId.set(item.id, { ...item });
  }
  const incoming = new Set(input.models.map((model) => model.requestId));

  for (const model of input.models) {
    const base = byId.get(model.requestId) ?? { id: model.requestId };
    const next: Record<string, unknown> = { ...base, id: model.requestId };
    next.name = model.displayName;

    applyNumber(next, "contextWindow", model.capabilities.contextWindow, input.metadataMode);
    applyNumber(next, "maxTokens", model.capabilities.maxOutputTokens, input.metadataMode);
    applyInput(next, model.capabilities.inputModalities, input.metadataMode, input.warnings, model.requestId);
    applyEfforts(next, model.capabilities.reasoningEfforts, input.metadataMode);

    byId.set(model.requestId, next);
  }

  if (
    input.strict &&
    input.confirmDeletions &&
    input.completeness === "complete" &&
    !input.usedFallback
  ) {
    for (const id of [...byId.keys()]) {
      if (!incoming.has(id)) {
        byId.delete(id);
        input.deletions.push(id);
      }
    }
  }
  return [...byId.values()];
}

function applyNumber(
  target: Record<string, unknown>,
  field: string,
  sourced: { value: number; source: string } | undefined,
  metadataMode: ModelMetadataMode,
): void {
  if (sourced === undefined) return;
  if (sourced.source === "models.dev" && metadataMode !== "write") return;
  target[field] = sourced.value;
}

function applyInput(
  target: Record<string, unknown>,
  sourced: { value: string[]; source: string } | undefined,
  metadataMode: ModelMetadataMode,
  warnings: Diagnostic[],
  modelId: string,
): void {
  if (sourced === undefined) return;
  if (sourced.source === "models.dev" && metadataMode !== "write") return;
  const filtered = sourced.value.filter((value) => value === "text" || value === "image");
  if (filtered.length !== sourced.value.length) {
    warnings.push({
      code: "DSH_MODALITY_DROPPED",
      severity: "warning",
      message: `Dropped modalities DSH cannot express for ${modelId}`,
      field: modelId,
    });
  }
  target.input = filtered;
}

function applyEfforts(
  target: Record<string, unknown>,
  sourced: { value: string[]; source: string } | undefined,
  metadataMode: ModelMetadataMode,
): void {
  if (sourced === undefined) return;
  if (sourced.source === "models.dev" && metadataMode !== "write") return;
  const efforts: Record<string, string> = {};
  for (const level of sourced.value) efforts[level] = level;
  if (Object.keys(efforts).length > 0) target.reasoningEfforts = efforts;
}

function readDefaultProvider(item: unknown): string | undefined {
  if (!isRecord(item) || !isRecord(item.config)) return undefined;
  const provider = item.config.provider;
  return typeof provider === "string" && provider !== "" ? provider : undefined;
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

function sameYaml(left: string, right: string): boolean {
  try {
    const a = parseDocument(left).toJS() as unknown;
    const b = parseDocument(right).toJS() as unknown;
    return stableStringify(a) === stableStringify(b);
  } catch {
    return left === right;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}