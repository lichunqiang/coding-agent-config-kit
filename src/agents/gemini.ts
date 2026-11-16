import { join } from "node:path";

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
  SemanticIntent,
} from "../types.js";
import { asJsonObject, deleteJsonPath, getJsonPath, parseJsonText, setJsonPath } from "../editing/json.js";
import { getDotenv, parseDotenv, removeDotenv, setDotenv } from "../editing/dotenv.js";
import type { AgentAdapter, AgentBuildInput, AgentPlan, PlannedFile } from "./types.js";

const BASE_URL_ENV = "GOOGLE_GEMINI_BASE_URL";
const API_KEY_ENV = "GEMINI_API_KEY";

export const geminiAdapter: AgentAdapter = {
  id: "gemini-cli",
  protocols: ["google-generative-ai"],
  placements: ["agent-file", "external-env"],
  supportsDefaultSlots: false,
  projectable: new Set<CapabilityName>(),
  async buildPlan(input: AgentBuildInput): Promise<AgentPlan> {
    const warnings: Diagnostic[] = [];
    const blockers: Diagnostic[] = [];
    const [settingsPath, envPath] = input.resolved.files;
    if (settingsPath === undefined || envPath === undefined) {
      throw new Error("Gemini target must expose settings.json and .env");
    }

    const settingsBefore = await readText(settingsPath);
    const envBefore = await readText(envPath);
    const settingsRoot = asJsonObject(
      parseJsonText(settingsBefore ?? "", settingsPath),
      settingsPath,
    );
    const envMap = parseDotenv(envBefore ?? "");

    const state =
      input.state ?? emptyManagementRecord(input.ownerId, "gemini-cli", input.resolved.configDir);
    const nextState = cloneState(state);
    const key = "connection:gemini-cli";
    const keyManaged = state.entries[key]?.baseline?.keyManaged === true;
    const adopt = new Set(input.ownership.adoptCredentialFields ?? []);
    const intents: IntentPreview[] = [];
    const redactions: string[] = [];
    let settingsAfter = settingsBefore ?? "";
    let envAfter = envBefore ?? "";
    let keyManagedNext = keyManaged;

    const existingKey = envMap[API_KEY_ENV];
    if (existingKey !== undefined && existingKey !== "") redactions.push(existingKey);

    let providerId = input.provider?.id;
    if (input.provider !== undefined) {
      envAfter = setDotenv(envAfter, BASE_URL_ENV, input.provider.baseUrl, envPath);
      intents.push({
        kind: "registerProvider",
        summary: `Point Gemini CLI at ${input.provider.baseUrl}`,
      });

      const placement = input.provider.credential.placement;
      if (placement.kind === "agent-file") {
        if (input.credentialValue === undefined) {
          blockers.push({
            code: "CREDENTIAL_UNAVAILABLE",
            severity: "error",
            message: "No credential value was resolved for agent-file placement",
          });
        } else if (
          existingKey !== undefined &&
          existingKey !== input.credentialValue &&
          !keyManaged &&
          !adopt.has(API_KEY_ENV)
        ) {
          blockers.push({
            code: "OWNERSHIP_CONFLICT",
            severity: "error",
            message: `.env already contains an unmanaged ${API_KEY_ENV}; adoptCredentialFields is required`,
            field: API_KEY_ENV,
          });
        } else {
          redactions.push(input.credentialValue);
          envAfter = setDotenv(envAfter, API_KEY_ENV, input.credentialValue, envPath);
          keyManagedNext = true;
        }
      } else if (existingKey !== undefined && existingKey !== "") {
        if (keyManaged || adopt.has(API_KEY_ENV)) {
          envAfter = removeDotenv(envAfter, API_KEY_ENV, envPath);
          keyManagedNext = false;
          warnings.push({
            code: "GEMINI_STALE_KEY_REMOVED",
            severity: "warning",
            message: "Removed the previously managed GEMINI_API_KEY so the launch environment supplies it",
            field: API_KEY_ENV,
          });
        } else {
          blockers.push({
            code: "OWNERSHIP_CONFLICT",
            severity: "error",
            message: `An unmanaged ${API_KEY_ENV} would shadow the launch environment`,
            field: API_KEY_ENV,
          });
        }
      } else {
        keyManagedNext = false;
      }

      nextState.entries[key] = {
        kind: "connection",
        fields: [BASE_URL_ENV, API_KEY_ENV],
        baseline: { baseUrl: input.provider.baseUrl, keyManaged: keyManagedNext },
      };
    }

    const defaultIntent = [...input.intents]
      .reverse()
      .find(
        (intent): intent is Extract<SemanticIntent, { kind: "setDefaultModel" }> =>
          intent.kind === "setDefaultModel",
      );
    if (defaultIntent !== undefined) {
      if (typeof settingsRoot.model === "string") {
        blockers.push({
          code: "UNPARSEABLE_CONFIG",
          severity: "error",
          message: 'settings.json uses a string "model"; expected an object with "name"',
          field: "model",
        });
      } else {
        settingsAfter = setJsonPath(settingsAfter, ["model", "name"], defaultIntent.modelId);
        intents.push({
          kind: "setDefaultModel",
          summary: `Set Gemini CLI model to ${defaultIntent.modelId}`,
        });
      }
    }

    if (input.intents.some((intent) => intent.kind === "unsetDefaultModel")) {
      settingsAfter = deleteJsonPath(settingsAfter, ["model", "name"]);
      intents.push({ kind: "unsetDefaultModel", summary: "Remove Gemini CLI default model" });
    }

    if ((input.lifecycle.removeProviders ?? []).length > 0) {
      blockers.push({
        code: "UNSUPPORTED_INTENT",
        severity: "error",
        message: "Gemini CLI has no provider registry to remove",
      });
    }
    if (Object.keys(input.lifecycle.removeModels ?? {}).length > 0) {
      blockers.push({
        code: "UNSUPPORTED_INTENT",
        severity: "error",
        message: "Gemini CLI has no model registry to remove",
      });
    }

    if (settingsBefore !== null && sameJson(settingsBefore, settingsAfter)) {
      settingsAfter = settingsBefore;
    }
    if (envBefore !== null && sameEnv(envBefore, envAfter)) {
      envAfter = envBefore;
    }

    const defaultChanged =
      defaultIntent !== undefined ||
      input.intents.some((intent) => intent.kind === "unsetDefaultModel");

    const layers: EffectivenessLayer[] = [
      {
        name: "system settings",
        observed: (await fileExists(systemSettingsPath())) ? "present" : "absent",
      },
      {
        name: "workspace .gemini/settings.json",
        observed: await pathState(input.resolved.projectSettingsPath),
      },
      {
        name: "launch environment",
        observed:
          input.target.launchEnvironment?.[BASE_URL_ENV] !== undefined
            ? "present"
            : input.target.launchEnvironment === undefined
              ? "unknown"
              : "absent",
      },
    ];

    let effectiveness: AgentPlan["effectiveness"];
    if (layers[0]!.observed === "present") {
      effectiveness = {
        level: "may-be-overridden",
        reasons: ["System-level Gemini settings exist"],
        layers,
      };
    } else if (layers[1]!.observed === "present") {
      effectiveness = {
        level: "may-be-overridden",
        reasons: ["A workspace .gemini/settings.json exists"],
        layers,
      };
    } else if (layers[2]!.observed === "present") {
      effectiveness = {
        level: "may-be-overridden",
        reasons: [`${BASE_URL_ENV} is present in the launch environment`],
        layers,
      };
    } else if (input.resolved.projectSettingsPath === undefined) {
      effectiveness = {
        level: "unknown",
        reasons: ["projectDir was not provided, so workspace settings cannot be checked"],
        layers,
      };
    } else {
      effectiveness = {
        level: "confirmed",
        reasons: ["No system, workspace or launch-environment override detected"],
        layers,
      };
    }

    const files: PlannedFile[] = [
      { path: settingsPath, before: settingsBefore, after: settingsAfter, mode: 0o600 },
      { path: envPath, before: envBefore, after: envAfter, mode: 0o600 },
    ];

    return {
      files,
      intents,
      effects: {
        defaultModelChanged: defaultChanged,
        currentConnectionChanged: providerId !== undefined,
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

function systemSettingsPath(): string {
  return process.platform === "win32"
    ? join("C:\\ProgramData", "gemini-cli", "settings.json")
    : "/etc/gemini-cli/settings.json";
}

async function pathState(
  path: string | undefined,
): Promise<"present" | "absent" | "unknown"> {
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

function sameEnv(left: string, right: string): boolean {
  return stableStringify(parseDotenv(left)) === stableStringify(parseDotenv(right));
}