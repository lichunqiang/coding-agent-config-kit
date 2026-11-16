import { readFileIfExists } from "../internal/fs.js";
import { stableStringify } from "../internal/hash.js";
import {
  emptyManagementRecord,
  type ManagementRecord,
} from "../internal/state.js";
import type {
  CapabilityName,
  Diagnostic,
  IntentPreview,
  ModelCapabilities,
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

const PI_PROJECTABLE: ReadonlySet<CapabilityName> = new Set<CapabilityName>([
  "contextWindow",
  "maxOutputTokens",
  "reasoning",
  "inputModalities",
]);

const API_BY_PROTOCOL: Record<Protocol, string> = {
  "openai-completions": "openai-completions",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic-messages",
  "google-generative-ai": "google-generative-ai",
};

interface PiModel extends Record<string, unknown> {
  id?: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
}

export const piAdapter: AgentAdapter = {
  id: "pi",
  protocols: [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ],
  placements: ["agent-file", "env-reference"],
  supportsDefaultSlots: false,
  projectable: PI_PROJECTABLE,
  agentDefaults: { contextWindow: 128_000, maxOutputTokens: 16_384 },
  async buildPlan(input: AgentBuildInput): Promise<AgentPlan> {
    const warnings: Diagnostic[] = [];
    const blockers: Diagnostic[] = [];
    const [modelsPath, settingsPath] = input.resolved.files;
    if (modelsPath === undefined || settingsPath === undefined) {
      throw new Error("Pi target must expose models.json and settings.json");
    }

    const modelsBefore = await readText(modelsPath);
    const settingsBefore = await readText(settingsPath);
    const modelsRoot = asJsonObject(parseJsonText(modelsBefore ?? "", modelsPath), modelsPath);
    const settingsRoot = asJsonObject(
      parseJsonText(settingsBefore ?? "", settingsPath),
      settingsPath,
    );

    const state =
      input.state ?? emptyManagementRecord(input.ownerId, "pi", input.resolved.configDir);
    const provider = input.provider;
    const providerId = provider?.id;
    const allowAdopt = new Set(input.ownership.adopt ?? []);
    const adopted: string[] = [];
    const ownershipConflicts: string[] = [];
    const redactions: string[] = [];
    const intents: IntentPreview[] = [];
    const deletions: string[] = [];

    let modelsAfter = modelsBefore ?? "";
    let settingsAfter = settingsBefore ?? "";
    let nextState = cloneState(state);

    if (provider !== undefined && providerId !== undefined) {
      validatePlacement(input, warnings, blockers);
      const providersRootValue = getJsonPath(modelsRoot, ["providers"]);
      const providersRoot =
        providersRootValue === undefined ? {} : asJsonObject(providersRootValue, modelsPath);
      const existingProvider = providersRoot[providerId];
      const stateKey = `provider:${providerId}`;
      const owned = state.entries[stateKey] !== undefined;

      if (existingProvider !== undefined && !owned && !allowAdopt.has(providerId)) {
        ownershipConflicts.push(providerId);
        blockers.push({
          code: "OWNERSHIP_CONFLICT",
          severity: "error",
          message: `Provider "${providerId}" already exists and is not managed by this owner`,
          field: `providers.${providerId}`,
        });
      } else {
        if (existingProvider !== undefined && !owned) adopted.push(providerId);
        const existingObject =
          existingProvider !== undefined && isRecord(existingProvider)
            ? existingProvider
            : {};
        const apiKey = credentialField(input, blockers, redactions);
        collectExistingSecrets(existingObject, redactions);

        const nextProvider: Record<string, unknown> = { ...existingObject };
        nextProvider.baseUrl = provider.baseUrl;
        nextProvider.api = API_BY_PROTOCOL[provider.protocol];
        if (apiKey !== undefined) {
          if (
            typeof existingObject.apiKey === "string" &&
            existingObject.apiKey.startsWith("!") &&
            apiKey !== existingObject.apiKey
          ) {
            warnings.push({
              code: "PI_APIKEY_COMMAND_REPLACED",
              severity: "warning",
              message: "The existing apiKey command form was replaced",
              field: `providers.${providerId}.apiKey`,
            });
          }
          nextProvider.apiKey = apiKey;
        }
        if (provider.displayName !== undefined) nextProvider.name = provider.displayName;
        nextProvider.models = mergePiModels({
          existing: existingObject.models,
          models: input.models,
          metadataMode: input.metadataMode,
          strict: input.strict,
          confirmDeletions: input.confirmDeletions,
          completeness: input.discoveryCompleteness,
          usedFallback: input.usedFallback,
          warnings,
          deletions,
        });
        modelsAfter = setJsonPath(modelsAfter, ["providers", providerId], nextProvider);

        nextState.entries[stateKey] = {
          kind: "provider",
          fields: ["baseUrl", "api", "apiKey", "models"],
          baseline: {
            modelIds: input.models.map((model) => model.requestId),
            apiKeyForm: apiKeyForm(apiKey),
          },
        };
        intents.push({
          kind: "registerProvider",
          summary: `Register provider ${providerId} (${provider.protocol})`,
        });
      }
    }

    const defaultIntent = [...input.intents]
      .reverse()
      .find((intent): intent is Extract<SemanticIntent, { kind: "setDefaultModel" }> =>
        intent.kind === "setDefaultModel",
      );
    if (defaultIntent !== undefined) {
      const providerForDefault = providerId ?? readDefaultProvider(settingsRoot);
      if (providerForDefault === undefined) {
        blockers.push({
          code: "UNSUPPORTED_INTENT",
          severity: "error",
          message: "setDefaultModel requires a provider in the same plan",
        });
      } else {
        settingsAfter = setJsonPath(settingsAfter, ["defaultProvider"], providerForDefault);
        settingsAfter = setJsonPath(settingsAfter, ["defaultModel"], defaultIntent.modelId);
        const enabled = getJsonPath(settingsRoot, ["enabledModels"]);
        if (Array.isArray(enabled)) {
          const patterns = enabled.filter((value): value is string => typeof value === "string");
          if (!patterns.some((pattern) => modelMatches(pattern, providerForDefault, defaultIntent.modelId))) {
            settingsAfter = setJsonPath(settingsAfter, ["enabledModels"], [
              ...patterns,
              `${providerForDefault}/${defaultIntent.modelId}`,
            ]);
            warnings.push({
              code: "PI_ENABLED_MODELS_UPDATED",
              severity: "warning",
              message: `enabledModels did not include the new default; added ${providerForDefault}/${defaultIntent.modelId}`,
              field: "enabledModels",
            });
          }
        }
        intents.push({
          kind: "setDefaultModel",
          summary: `Set Pi default model to ${providerForDefault}/${defaultIntent.modelId}`,
        });
      }
    }

    if (input.intents.some((intent) => intent.kind === "unsetDefaultModel")) {
      if (getJsonPath(settingsRoot, ["defaultModel"]) !== undefined) {
        settingsAfter = deleteJsonPath(settingsAfter, ["defaultModel"]);
      }
      if (getJsonPath(settingsRoot, ["defaultProvider"]) !== undefined) {
        settingsAfter = deleteJsonPath(settingsAfter, ["defaultProvider"]);
      }
      intents.push({ kind: "unsetDefaultModel", summary: "Remove Pi default model" });
    }

    for (const removeId of input.lifecycle.removeProviders ?? []) {
      const stateKey = `provider:${removeId}`;
      if (state.entries[stateKey] === undefined) {
        blockers.push({
          code: "OWNERSHIP_CONFLICT",
          severity: "error",
          message: `Cannot remove provider "${removeId}" because it is not managed by this owner`,
          field: `providers.${removeId}`,
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
      modelsAfter = deleteJsonPath(modelsAfter, ["providers", removeId]);
      delete nextState.entries[stateKey];
      if (readDefaultProvider(settingsRoot) === removeId) {
        warnings.push({
          code: "PI_DEFAULT_MODEL_DANGLING",
          severity: "warning",
          message: `Removed provider "${removeId}" is still the configured default provider`,
          field: "defaultProvider",
        });
      }
      intents.push({
        kind: "removeProvider",
        summary: `Remove provider ${removeId}`,
      });
    }

    for (const [removeProviderId, modelIds] of Object.entries(
      input.lifecycle.removeModels ?? {},
    )) {
      const stateKey = `provider:${removeProviderId}`;
      if (state.entries[stateKey] === undefined) {
        blockers.push({
          code: "OWNERSHIP_CONFLICT",
          severity: "error",
          message: `Cannot remove models from unmanaged provider "${removeProviderId}"`,
        });
        continue;
      }
      const existing = getJsonPath(modelsRoot, ["providers", removeProviderId, "models"]);
      if (Array.isArray(existing)) {
        const kept = existing.filter(
          (item) =>
            !(
              isRecord(item) &&
              typeof item.id === "string" &&
              modelIds.includes(item.id)
            ),
        );
        modelsAfter = setJsonPath(
          modelsAfter,
          ["providers", removeProviderId, "models"],
          kept,
        );
        intents.push({
          kind: "removeModel",
          summary: `Remove ${modelIds.length} model(s) from ${removeProviderId}`,
        });
      }
    }

    nextState.updatedAt = input.now.toISOString();
    nextState.ownerId = input.ownerId;
    nextState.configDir = input.resolved.configDir;

    const defaultChanged =
      defaultIntent !== undefined ||
      input.intents.some((intent) => intent.kind === "unsetDefaultModel");

    let effectiveness: AgentPlan["effectiveness"];
    const layers: AgentPlan["effectiveness"]["layers"] = [];
    if (input.resolved.projectSettingsPath === undefined) {
      layers.push({ name: "project .pi/settings.json", observed: "unknown" });
      layers.push({ name: "CLI --provider/--model", observed: "unknown" });
      effectiveness = {
        level: "unknown",
        reasons: ["projectDir was not provided, so project settings cannot be checked"],
        layers,
      };
    } else {
      const projectText = await readText(input.resolved.projectSettingsPath);
      if (projectText === null) {
        layers.push({ name: "project .pi/settings.json", observed: "absent" });
        layers.push({ name: "CLI --provider/--model", observed: "unknown" });
        effectiveness = {
          level: "confirmed",
          reasons: ["No project settings override the user agent directory"],
          layers,
        };
      } else {
        const projectValue = asJsonObject(
          parseJsonText(projectText, input.resolved.projectSettingsPath),
          input.resolved.projectSettingsPath,
        );
        const overrides =
          getJsonPath(projectValue, ["defaultModel"]) !== undefined ||
          getJsonPath(projectValue, ["defaultProvider"]) !== undefined ||
          getJsonPath(projectValue, ["enabledModels"]) !== undefined;
        layers.push({
          name: "project .pi/settings.json",
          observed: overrides ? "present" : "absent",
        });
        layers.push({ name: "CLI --provider/--model", observed: "unknown" });
        effectiveness = overrides
          ? {
              level: "may-be-overridden",
              reasons: ["Project settings define default model fields"],
              layers,
            }
          : {
              level: "confirmed",
              reasons: ["Project settings exist but do not override default model fields"],
              layers,
            };
      }
    }

    if (modelsBefore !== null && sameJson(modelsBefore, modelsAfter)) {
      modelsAfter = modelsBefore;
    }
    if (settingsBefore !== null && sameJson(settingsBefore, settingsAfter)) {
      settingsAfter = settingsBefore;
    }

    const files: PlannedFile[] = [
      { path: modelsPath, before: modelsBefore, after: modelsAfter, mode: 0o600 },
      { path: settingsPath, before: settingsBefore, after: settingsAfter, mode: 0o600 },
    ];

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
      adopted,
      ownershipConflicts,
      deletions,
      redactions,
    };
  },
};

function validatePlacement(
  input: AgentBuildInput,
  warnings: Diagnostic[],
  blockers: Diagnostic[],
): void {
  if (input.provider === undefined) return;
  const placement = input.provider.credential.placement;
  if (placement.kind === "external-env") {
    blockers.push({
      code: "UNSUPPORTED_INTENT",
      severity: "error",
      message: "Pi requires an apiKey field; use agent-file or env-reference",
    });
  }
  if (
    placement.kind === "agent-file" &&
    (input.credentialValue === undefined || input.credentialValue === "")
  ) {
    blockers.push({
      code: "CREDENTIAL_UNAVAILABLE",
      severity: "error",
      message: "Credential value is required for agent-file placement",
    });
  }
  if (placement.kind === "env-reference" && placement.envVar === "") {
    blockers.push({
      code: "ENV_REFERENCE_UNRESOLVED",
      severity: "error",
      message: "env-reference placement requires envVar",
    });
  }
  if (placement.kind === "env-reference") {
    warnings.push({
      code: "PI_ENV_REFERENCE",
      severity: "warning",
      message: `apiKey will reference $${placement.envVar} at runtime`,
    });
  }
}

function credentialField(
  input: AgentBuildInput,
  blockers: Diagnostic[],
  redactions: string[],
): string | undefined {
  const placement = input.provider?.credential.placement;
  if (placement === undefined) return undefined;
  switch (placement.kind) {
    case "agent-file":
      if (input.credentialValue !== undefined) {
        redactions.push(input.credentialValue);
        return input.credentialValue;
      }
      blockers.push({
        code: "CREDENTIAL_UNAVAILABLE",
        severity: "error",
        message: "No credential value was resolved for agent-file placement",
      });
      return undefined;
    case "env-reference":
      return `$${placement.envVar}`;
    case "external-env":
      return undefined;
  }
}

function collectExistingSecrets(
  provider: Record<string, unknown>,
  redactions: string[],
): void {
  const apiKey = provider.apiKey;
  if (
    typeof apiKey === "string" &&
    apiKey !== "" &&
    !apiKey.startsWith("$") &&
    !apiKey.startsWith("!")
  ) {
    redactions.push(apiKey);
  }
}

interface MergePiModelsInput {
  existing: unknown;
  models: ResolvedModel[];
  metadataMode: ModelMetadataMode;
  strict: boolean;
  confirmDeletions: boolean;
  completeness: "complete" | "partial" | "unknown";
  usedFallback: boolean;
  warnings: Diagnostic[];
  deletions: string[];
}

function mergePiModels(input: MergePiModelsInput): PiModel[] {
  const existing = Array.isArray(input.existing)
    ? input.existing.filter(isRecord).map((item) => ({ ...item }))
    : [];
  const nextById = new Map<string, PiModel>();
  for (const item of existing) {
    const id = typeof item.id === "string" ? item.id : undefined;
    if (id !== undefined) nextById.set(id, item);
  }

  const incomingIds = new Set(input.models.map((model) => model.requestId));
  for (const model of input.models) {
    const base = nextById.get(model.requestId) ?? { id: model.requestId };
    const next: PiModel = { ...base, id: model.requestId };
    next.name = model.displayName;
    applyCapability(next, "reasoning", model.capabilities, input.metadataMode);
    applyCapability(next, "contextWindow", model.capabilities, input.metadataMode);
    applyCapability(next, "maxTokens", model.capabilities, input.metadataMode);

    const modalities = model.capabilities.inputModalities;
    if (
      modalities !== undefined &&
      (input.metadataMode === "write" || modalities.source !== "models.dev")
    ) {
      const filtered = modalities.value.filter(
        (value) => value === "text" || value === "image",
      );
      if (filtered.length !== modalities.value.length) {
        input.warnings.push({
          code: "PI_MODALITY_DROPPED",
          severity: "warning",
          message: `Dropped modalities Pi cannot express for ${model.requestId}`,
          field: model.requestId,
        });
      }
      next.input = filtered;
    }
    nextById.set(model.requestId, next);
  }

  if (
    input.strict &&
    input.confirmDeletions &&
    input.completeness === "complete" &&
    !input.usedFallback
  ) {
    for (const id of [...nextById.keys()]) {
      if (!incomingIds.has(id)) {
        nextById.delete(id);
        input.deletions.push(id);
      }
    }
  }

  return [...nextById.values()];
}

function applyCapability(
  target: PiModel,
  field: "reasoning" | "contextWindow" | "maxTokens",
  capabilities: ModelCapabilities,
  metadataMode: ModelMetadataMode,
): void {
  const name =
    field === "contextWindow"
      ? "contextWindow"
      : field === "maxTokens"
        ? "maxOutputTokens"
        : "reasoning";
  const sourced = capabilities[name as CapabilityName];
  if (sourced === undefined) return;
  if (sourced.source === "models.dev" && metadataMode !== "write") return;
  target[field] = sourced.value as never;
}

function modelMatches(pattern: string, providerId: string, modelId: string): boolean {
  const full = `${providerId}/${modelId}`;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  try {
    return new RegExp(`^${escaped}$`).test(full) || new RegExp(`^${escaped}$`).test(modelId);
  } catch {
    return pattern === full || pattern === modelId;
  }
}

function readDefaultProvider(settings: Record<string, unknown>): string | undefined {
  const provider = settings.defaultProvider;
  return typeof provider === "string" && provider !== "" ? provider : undefined;
}

function apiKeyForm(apiKey: string | undefined): "none" | "env-reference" | "command" | "literal" {
  if (apiKey === undefined) return "none";
  if (apiKey.startsWith("$")) return "env-reference";
  if (apiKey.startsWith("!")) return "command";
  return "literal";
}

function cloneState(state: ManagementRecord): ManagementRecord {
  return {
    ...state,
    entries: Object.fromEntries(
      Object.entries(state.entries).map(([key, entry]) => [
        key,
        { ...entry, fields: [...entry.fields], ...(entry.baseline === undefined ? {} : { baseline: { ...entry.baseline } }) },
      ]),
    ),
  };
}

async function readText(path: string): Promise<string | null> {
  const bytes = await readFileIfExists(path);
  return bytes === null ? null : bytes.toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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