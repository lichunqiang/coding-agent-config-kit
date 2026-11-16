import { join } from "node:path";

import { readFileIfExists, fileExists } from "../internal/fs.js";
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
  SemanticIntent,
} from "../types.js";
import {
  parseTomlText,
  removeTomlTable,
  removeTomlTopLevel,
  setTomlTable,
  setTomlTopLevel,
} from "../editing/toml.js";
import type { AgentAdapter, AgentBuildInput, AgentPlan, PlannedFile } from "./types.js";

export const codexAdapter: AgentAdapter = {
  id: "codex",
  protocols: ["openai-responses"],
  placements: ["env-reference"],
  supportsDefaultSlots: false,
  // Codex has no model catalog in the config; capabilities stay advisory.
  projectable: new Set<CapabilityName>(),
  async buildPlan(input: AgentBuildInput): Promise<AgentPlan> {
    const warnings: Diagnostic[] = [];
    const blockers: Diagnostic[] = [];
    const configPath = input.resolved.files[0];
    if (configPath === undefined) throw new Error("Codex target has no config file");

    const before = await readText(configPath);
    const root = parseTomlText(before ?? "", configPath);
    const state =
      input.state ?? emptyManagementRecord(input.ownerId, "codex", input.resolved.configDir);
    const nextState = cloneState(state);
    const intents: IntentPreview[] = [];
    const redactions: string[] = [];
    let after = before ?? "";
    let providerId = input.provider?.id;
    const providerSpec = input.provider;
    const adopt = new Set(input.ownership.adopt ?? []);

    if (providerSpec !== undefined && providerId !== undefined) {
      const existingProviders = root.model_providers;
      const existing =
        isRecord(existingProviders) && isRecord(existingProviders[providerId])
          ? (existingProviders[providerId] as Record<string, unknown>)
          : undefined;
      const stateKey = `provider:${providerId}`;
      const owned = state.entries[stateKey] !== undefined;

      if (existing !== undefined && !owned && !adopt.has(providerId)) {
        blockers.push({
          code: "OWNERSHIP_CONFLICT",
          severity: "error",
          message: `Codex provider "${providerId}" already exists and is not managed by this owner`,
          field: `model_providers.${providerId}`,
        });
      } else {
        const placement = providerSpec.credential.placement;
        if (placement.kind !== "env-reference") {
          blockers.push({
            code: "UNSUPPORTED_INTENT",
            severity: "error",
            message: "Codex providers require env-reference credentials (env_key)",
          });
        } else {
          after = setTomlTable(
            after,
            ["model_providers", providerId],
            {
              name: providerSpec.displayName ?? providerId,
              base_url: providerSpec.baseUrl,
              env_key: placement.envVar,
              wire_api: "responses",
              requires_openai_auth: false,
            },
            configPath,
          );
          nextState.entries[stateKey] = {
            kind: "provider",
            fields: [
              "name",
              "base_url",
              "env_key",
              "wire_api",
              "requires_openai_auth",
            ],
            baseline: { baseUrl: providerSpec.baseUrl, envKey: placement.envVar },
          };
          intents.push({
            kind: "registerProvider",
            summary: `Register Codex provider ${providerId} (Responses)`,
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
      const existingDefault =
        typeof root.model_provider === "string" ? root.model_provider : undefined;
      const targetProvider = providerId ?? existingDefault;
      if (targetProvider === undefined) {
        blockers.push({
          code: "UNSUPPORTED_INTENT",
          severity: "error",
          message: "setDefaultModel requires a provider in the same plan",
        });
      } else {
        after = setTomlTopLevel(after, "model_provider", targetProvider, configPath);
        after = setTomlTopLevel(after, "model", defaultIntent.modelId, configPath);
        intents.push({
          kind: "setDefaultModel",
          summary: `Set Codex default to ${targetProvider}/${defaultIntent.modelId}`,
        });
        if (providerId !== undefined && nextState.entries[`provider:${providerId}`] !== undefined) {
          nextState.entries[`provider:${providerId}`] = {
            ...nextState.entries[`provider:${providerId}`]!,
            fields: [...new Set([...nextState.entries[`provider:${providerId}`]!.fields, "model", "model_provider"])],
          };
        }
      }
    }

    if (input.intents.some((intent) => intent.kind === "unsetDefaultModel")) {
      after = removeTomlTopLevel(after, "model", configPath);
      after = removeTomlTopLevel(after, "model_provider", configPath);
      intents.push({ kind: "unsetDefaultModel", summary: "Remove Codex default model" });
    }

    for (const removeId of input.lifecycle.removeProviders ?? []) {
      const stateKey = `provider:${removeId}`;
      if (state.entries[stateKey] === undefined) {
        blockers.push({
          code: "OWNERSHIP_CONFLICT",
          severity: "error",
          message: `Cannot remove unmanaged Codex provider "${removeId}"`,
          field: `model_providers.${removeId}`,
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
      after = removeTomlTable(after, ["model_providers", removeId], configPath);
      delete nextState.entries[stateKey];
      if (root.model_provider === removeId) {
        after = removeTomlTopLevel(after, "model", configPath);
        after = removeTomlTopLevel(after, "model_provider", configPath);
        warnings.push({
          code: "CODEX_DEFAULT_MODEL_REMOVED",
          severity: "warning",
          message: `Removed provider "${removeId}" was the default; its model selection was cleared`,
        });
      }
      intents.push({ kind: "removeProvider", summary: `Remove Codex provider ${removeId}` });
    }

    if (Object.keys(input.lifecycle.removeModels ?? {}).length > 0) {
      blockers.push({
        code: "UNSUPPORTED_INTENT",
        severity: "error",
        message: "Codex has no per-provider model registry",
      });
    }

    if (before !== null && sameToml(before, after, configPath)) after = before;

    const defaultChanged =
      defaultIntent !== undefined ||
      input.intents.some((intent) => intent.kind === "unsetDefaultModel");

    const layers: EffectivenessLayer[] = [
      {
        name: "project .codex/config.toml",
        observed: await layerState(input.resolved.projectSettingsPath),
      },
      {
        name: "system config",
        observed: (await fileExists(systemConfigPath())) ? "present" : "absent",
      },
      { name: "CLI -c / profiles", observed: "unknown" },
    ];

    let effectiveness: AgentPlan["effectiveness"];
    if (layers[1]!.observed === "present") {
      effectiveness = {
        level: "may-be-overridden",
        reasons: ["A system-level Codex config exists"],
        layers,
      };
    } else if (layers[0]!.observed === "unknown") {
      effectiveness = {
        level: "unknown",
        reasons: ["projectDir was not provided, so project config cannot be checked"],
        layers,
      };
    } else if (layers[0]!.observed === "present") {
      effectiveness = {
        level: "may-be-overridden",
        reasons: ["A project .codex/config.toml exists and loads after user config"],
        layers,
      };
    } else {
      effectiveness = {
        level: "confirmed",
        reasons: ["No project or system config overrides the user config"],
        layers,
      };
    }

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

function systemConfigPath(): string {
  return process.platform === "win32"
    ? join("C:\\ProgramData", "codex", "config.toml")
    : "/etc/codex/config.toml";
}

async function layerState(path: string | undefined): Promise<"present" | "absent" | "unknown"> {
  if (path === undefined) return "unknown";
  return (await fileExists(path)) ? "present" : "absent";
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

function sameToml(left: string, right: string, path: string): boolean {
  try {
    return (
      stableStringify(parseTomlText(left, path)) ===
      stableStringify(parseTomlText(right, path))
    );
  } catch {
    return left === right;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}