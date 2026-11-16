import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { ConfigKitError } from "../errors.js";
import type { AgentId, Diagnostic, Target } from "../types.js";
import { fileExists } from "../internal/fs.js";

export interface ResolvedTarget {
  agent: AgentId;
  configDir: string;
  profile?: string;
  files: string[];
  projectSettingsPath?: string;
  agentVersion?: string;
  warnings: Diagnostic[];
  blockers: Diagnostic[];
}

const ENV_NAMES: Record<AgentId, string | undefined> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  "gemini-cli": "GEMINI_CLI_HOME",
  opencode: undefined,
  pi: "PI_CODING_AGENT_DIR",
  "deepseek-harness": "DSH_HOME",
};

export async function resolveAgentTarget(
  agent: AgentId,
  target: Target,
): Promise<ResolvedTarget> {
  const warnings: Diagnostic[] = [];
  const blockers: Diagnostic[] = [];
  const envName = ENV_NAMES[agent];
  const envValue =
    envName === undefined ? undefined : target.launchEnvironment?.[envName];

  const profile = target.profile;
  if (agent === "deepseek-harness" && (profile === undefined || profile === "")) {
    blockers.push({
      code: "UNSAFE_TARGET",
      severity: "error",
      message: "DeepSeek Harness requires target.profile",
    });
  }

  const defaultDir = defaultConfigDir(agent, profile, target.launchEnvironment);
  const envDir = envValue === undefined ? undefined : envDerivedDir(agent, envValue, profile);

  let configDir: string;
  if (target.configDir !== undefined) {
    configDir = resolve(target.configDir);
    const envResolved = envDir === undefined ? undefined : resolve(envDir);
    const samePath =
      envResolved === undefined
        ? true
        : process.platform === "win32"
          ? envResolved.toLowerCase() === configDir.toLowerCase()
          : envResolved === configDir;
    if (!samePath) {
      blockers.push({
        code: "TARGET_ENV_MISMATCH",
        severity: "error",
        message: `${envName} points to ${envDir} but configDir is ${configDir}`,
        path: configDir,
      });
    }
  } else if (envDir !== undefined) {
    configDir = resolve(envDir);
  } else {
    configDir = resolve(defaultDir);
  }

  const files = await filesFor(agent, configDir);
  const projectSettingsPath = projectLayerPath(agent, target.projectDir);

  let agentVersion = target.agentVersion;
  if (agentVersion === undefined && target.versionProbe !== undefined) {
    if (!isAbsolute(target.versionProbe.executable)) {
      warnings.push({
        code: "VERSION_PROBE_IGNORED",
        severity: "warning",
        message: "versionProbe.executable must be an absolute path",
      });
    } else {
      agentVersion = await probeVersion(agent, target.versionProbe.executable, warnings);
    }
  }

  const resolvedTarget: ResolvedTarget = {
    agent,
    configDir,
    files,
    warnings,
    blockers,
  };
  if (profile !== undefined && profile !== "") resolvedTarget.profile = profile;
  if (projectSettingsPath !== undefined) {
    resolvedTarget.projectSettingsPath = projectSettingsPath;
  }
  if (agentVersion !== undefined) resolvedTarget.agentVersion = agentVersion;
  return resolvedTarget;
}

function defaultConfigDir(
  agent: AgentId,
  profile: string | undefined,
  launchEnvironment: Target["launchEnvironment"],
): string {
  const home = homedir();
  switch (agent) {
    case "claude-code":
      return join(home, ".claude");
    case "codex":
      return join(home, ".codex");
    case "gemini-cli":
      return join(home, ".gemini");
    case "opencode":
      return join(
        launchEnvironment?.XDG_CONFIG_HOME ?? join(home, ".config"),
        "opencode",
      );
    case "pi":
      return join(home, ".pi", "agent");
    case "deepseek-harness":
      return join(home, ".dsh", "profiles", profile ?? "default");
  }
}

function envDerivedDir(
  agent: AgentId,
  envValue: string,
  profile: string | undefined,
): string {
  switch (agent) {
    case "gemini-cli":
      return join(envValue, ".gemini");
    case "deepseek-harness":
      return join(envValue, "profiles", profile ?? "default");
    default:
      return envValue;
  }
}

async function filesFor(agent: AgentId, configDir: string): Promise<string[]> {
  switch (agent) {
    case "claude-code":
      return [join(configDir, "settings.json")];
    case "codex":
      return [join(configDir, "config.toml")];
    case "gemini-cli":
      return [join(configDir, "settings.json"), join(configDir, ".env")];
    case "opencode": {
      const jsonc = join(configDir, "opencode.jsonc");
      const json = join(configDir, "opencode.json");
      if (await fileExists(jsonc)) return [jsonc];
      return [json];
    }
    case "pi":
      return [join(configDir, "models.json"), join(configDir, "settings.json")];
    case "deepseek-harness":
      return [join(configDir, "cordis.patch.yml")];
  }
}

function projectLayerPath(agent: AgentId, projectDir: string | undefined): string | undefined {
  if (projectDir === undefined) return undefined;
  switch (agent) {
    case "claude-code":
      return join(projectDir, ".claude", "settings.local.json");
    case "codex":
      return join(projectDir, ".codex", "config.toml");
    case "gemini-cli":
      return join(projectDir, ".gemini", "settings.json");
    case "opencode":
      return join(projectDir, "opencode.json");
    case "pi":
      return join(projectDir, ".pi", "settings.json");
    case "deepseek-harness":
      return undefined;
  }
}

async function probeVersion(
  agent: AgentId,
  executable: string,
  warnings: Diagnostic[],
): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    let output = "";
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, ["--version"], {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
        windowsHide: true,
        // Do not leak the SDK process environment (which may hold credentials)
        // into a target executable.
        env:
          process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot ?? "" }
            : {},
      });
    } catch (error) {
      warnings.push({
        code: "VERSION_PROBE_FAILED",
        severity: "warning",
        message: `Unable to start ${agent} version probe: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      finish(undefined);
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length < 4_096) output += chunk.toString("utf8");
    });
    child.on("error", () => finish(undefined));
    child.on("close", () => {
      const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
      if (match === null) {
        warnings.push({
          code: "VERSION_PROBE_UNPARSED",
          severity: "warning",
          message: `Could not parse ${agent} --version output`,
        });
        finish(undefined);
        return;
      }
      finish(match[1]);
    });
  });
}

export function assertSupportedProtocol(
  agent: AgentId,
  protocols: readonly string[],
  protocol: string,
): void {
  if (!protocols.includes(protocol)) {
    throw new ConfigKitError({
      code: "UNSUPPORTED_PROTOCOL",
      message: `${agent} does not support ${protocol} for direct inference`,
      agent,
      phase: "validate",
      field: "provider.protocol",
    });
  }
}