import { join } from "node:path";

import { ConfigKitError } from "../errors.js";
import { readFileIfExists, fileExists } from "../internal/fs.js";
import { stableStringify } from "../internal/hash.js";
import {
  emptyManagementRecord,
  type ManagementRecord,
} from "../internal/state.js";
import type {
  CapabilityName,
  Diagnostic,
  IntentPreview,
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

const TOKEN_FIELD = "env.ANTHROPIC_AUTH_TOKEN";
const MODEL_FIELDS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

export const claudeAdapter: AgentAdapter = {
  id: "claude-code",
  protocols: ["anthropic-messages"],
  placements: ["agent-file", "external-env"],
  supportsDefaultSlots: true,
  // Claude Code has no model registry; capabilities are advisory only.
  projectable: new Set<CapabilityName>(),
  async buildPlan(input: AgentBuildInput): Promise<AgentPlan> {
    const warnings: Diagnostic[] = [];
    const blockers: Diagnostic[] = [];
    const settingsPath = input.resolved.files[0];
    if (settingsPath === undefined) throw new Error("Claude Code target has no settings file");

    const before = await readText(settingsPath);
    const root = asJsonObject(parseJsonText(before ?? "", settingsPath), settingsPath);
    const state =
      input.state ??
      emptyManagementRecord(input.ownerId, "claude-code", input.resolved.configDir);
    const nextState = cloneState(state);
    const entries = nextState.entries;
    const key = "connection:claude-code";
    const managedToken = state.entries[key]?.baseline?.tokenManaged === true;
    const provider = input.provider;
    const adoptCredential = new Set(input.ownership.adoptCredentialFields ?? []);
    const intents: IntentPreview[] = [];
    const redactions: string[] = [];
    let after = before ?? "";
    let tokenManaged = managedToken;

    const existingToken = getJsonPath(root, ["env", "ANTHROPIC_AUTH_TOKEN"]);
    if (typeof existingToken === "string" && existingToken !== "") {
      redactions.push(existingToken);
    }

    if (provider !== undefined) {
      after = setJsonPath(after, ["env", "ANTHROPIC_BASE_URL"], provider.baseUrl);
      intents.push({
        kind: "registerProvider",
        summary: `Route Claude Code to ${new URL(provider.baseUrl).host}`,
      });

      const placement = provider.credential.placement;
      if (placement.kind === "agent-file") {
        if (input.credentialValue === undefined) {
          blockers.push({
            code: "CREDENTIAL_UNAVAILABLE",
            severity: "error",
            message: "No credential value was resolved for agent-file placement",
          });
        } else if (
          existingToken !== undefined &&
          existingToken !== input.credentialValue &&
          !managedToken &&
          !adoptCredential.has(TOKEN_FIELD)
        ) {
          blockers.push({
            code: "OWNERSHIP_CONFLICT",
            severity: "error",
            message:
              "settings.json already contains an unmanaged ANTHROPIC_AUTH_TOKEN; adoptCredentialFields is required",
            field: TOKEN_FIELD,
          });
        } else {
          redactions.push(input.credentialValue);
          after = setJsonPath(
            after,
            ["env", "ANTHROPIC_AUTH_TOKEN"],
            input.credentialValue,
          );
          tokenManaged = true;
        }
      } else {
        // external-env: the caller injects ANTHROPIC_AUTH_TOKEN at launch.
        if (existingToken !== undefined && existingToken !== "") {
          if (managedToken || adoptCredential.has(TOKEN_FIELD)) {
            after = deleteJsonPath(after, ["env", "ANTHROPIC_AUTH_TOKEN"]);
            tokenManaged = false;
            warnings.push({
              code: "CLAUDE_STALE_TOKEN_REMOVED",
              severity: "warning",
              message:
                "Removed the previously managed ANTHROPIC_AUTH_TOKEN so the launch environment can supply it",
              field: TOKEN_FIELD,
            });
          } else {
            blockers.push({
              code: "OWNERSHIP_CONFLICT",
              severity: "error",
              message:
                "An unmanaged ANTHROPIC_AUTH_TOKEN would shadow the launch environment; remove or adopt it first",
              field: TOKEN_FIELD,
            });
          }
        } else {
          tokenManaged = false;
        }
      }

      nextState.entries[key] = {
        kind: "connection",
        fields: ["env.ANTHROPIC_BASE_URL", ...MODEL_FIELDS.map((field) => `env.${field}`)],
        baseline: {
          baseUrl: provider.baseUrl,
          tokenManaged,
        },
      };
    }

    const defaultIntent = [...input.intents]
      .reverse()
      .find(
        (intent): intent is Extract<SemanticIntent, { kind: "setDefaultModel" }> =>
          intent.kind === "setDefaultModel",
      );
    if (defaultIntent !== undefined) {
      const slots = defaultIntent.slots ?? {};
      after = setJsonPath(after, ["env", "ANTHROPIC_MODEL"], defaultIntent.modelId);
      after = setJsonPath(
        after,
        ["env", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
        slots.opus ?? defaultIntent.modelId,
      );
      after = setJsonPath(
        after,
        ["env", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
        slots.sonnet ?? defaultIntent.modelId,
      );
      after = setJsonPath(
        after,
        ["env", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
        slots.haiku ?? defaultIntent.modelId,
      );
      intents.push({
        kind: "setDefaultModel",
        summary: `Set Claude Code defaults to ${defaultIntent.modelId}${
          Object.keys(slots).length > 0 ? ` (${JSON.stringify(slots)})` : ""
        }`,
      });
      if (entries[key] !== undefined) {
        entries[key] = {
          ...entries[key],
          fields: [...new Set([...entries[key]!.fields, ...MODEL_FIELDS.map((field) => `env.${field}`)])],
        };
      }
    }

    if (input.intents.some((intent) => intent.kind === "unsetDefaultModel")) {
      for (const field of MODEL_FIELDS) {
        if (getJsonPath(root, ["env", field]) !== undefined) {
          after = deleteJsonPath(after, ["env", field]);
        }
      }
      intents.push({ kind: "unsetDefaultModel", summary: "Remove Claude Code default model" });
    }

    if ((input.lifecycle.removeProviders ?? []).length > 0) {
      blockers.push({
        code: "UNSUPPORTED_INTENT",
        severity: "error",
        message: "Claude Code has no provider registry to remove; replace the current connection instead",
      });
    }
    if (Object.keys(input.lifecycle.removeModels ?? {}).length > 0) {
      blockers.push({
        code: "UNSUPPORTED_INTENT",
        severity: "error",
        message: "Claude Code has no model registry to remove",
      });
    }

    if (before !== null && sameJson(before, after)) after = before;

    const defaultChanged =
      defaultIntent !== undefined ||
      input.intents.some((intent) => intent.kind === "unsetDefaultModel");
    const managedPath = managedSettingsPath();
    const managedPresent = managedPath === undefined ? false : await fileExists(managedPath);
    const projectText =
      input.resolved.projectSettingsPath === undefined
        ? null
        : await readText(input.resolved.projectSettingsPath);
    const layers = [
      {
        name: "enterprise managed settings",
        observed: (managedPresent ? "present" : "absent") as "present" | "absent",
        ...(managedPath === undefined ? {} : { note: managedPath }),
      },
      {
        name: "project .claude/settings.local.json",
        observed: (projectText === null
          ? input.resolved.projectSettingsPath === undefined
            ? "unknown"
            : "absent"
          : "present") as "present" | "absent" | "unknown",
      },
      { name: "CLI arguments", observed: "unknown" as const },
    ];

    let projectOverrides = false;
    if (projectText !== null && input.resolved.projectSettingsPath !== undefined) {
      try {
        const projectRoot = asJsonObject(
          parseJsonText(projectText, input.resolved.projectSettingsPath),
          input.resolved.projectSettingsPath,
        );
        const projectEnv = getJsonPath(projectRoot, ["env"]);
        projectOverrides =
          projectEnv !== undefined &&
          (getJsonPath(projectEnv, ["ANTHROPIC_BASE_URL"]) !== undefined ||
            getJsonPath(projectEnv, ["ANTHROPIC_AUTH_TOKEN"]) !== undefined ||
            MODEL_FIELDS.some((field) => getJsonPath(projectEnv, [field]) !== undefined));
      } catch {
        projectOverrides = true;
      }
    }

    let effectiveness: AgentPlan["effectiveness"];
    if (managedPresent) {
      effectiveness = {
        level: "may-be-overridden",
        reasons: ["Enterprise managed settings exist and outrank user settings"],
        layers,
      };
    } else if (projectOverrides) {
      effectiveness = {
        level: "may-be-overridden",
        reasons: ["Project .claude/settings.local.json overrides connection or model fields"],
        layers,
      };
    } else if (input.resolved.projectSettingsPath === undefined) {
      effectiveness = {
        level: "unknown",
        reasons: ["projectDir was not provided, so project settings cannot be checked"],
        layers,
      };
    } else {
      effectiveness = {
        level: "confirmed",
        reasons: ["No managed or project settings override the user settings"],
        layers,
      };
    }

    const files: PlannedFile[] = [
      { path: settingsPath, before, after, mode: 0o600 },
    ];

    return {
      files,
      intents,
      effects: {
        defaultModelChanged: defaultChanged,
        currentConnectionChanged: provider !== undefined,
      },
      effectiveness,
      warnings,
      blockers,
      state: nextState,
      adopted: [],
      ownershipConflicts:
        blockers.filter((blocker) => blocker.code === "OWNERSHIP_CONFLICT").length > 0
          ? ["claude-code.credentials"]
          : [],
      deletions: [],
      redactions,
    };
  },
};

function managedSettingsPath(): string | undefined {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "win32":
      return join("C:\\ProgramData", "ClaudeCode", "managed-settings.json");
    default:
      return "/etc/claude-code/managed-settings.json";
  }
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

export function claudeProtocolError(): ConfigKitError {
  return new ConfigKitError({
    code: "UNSUPPORTED_PROTOCOL",
    message: "Claude Code supports Anthropic Messages only",
    agent: "claude-code",
    phase: "validate",
  });
}