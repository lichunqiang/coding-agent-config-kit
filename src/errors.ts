/** Stable error codes emitted by coding-agent-config-kit. */
export type ConfigKitErrorCode =
  | "UNSUPPORTED_PROTOCOL"
  | "UNSUPPORTED_INTENT"
  | "UNSUPPORTED_AGENT"
  | "MODEL_DISCOVERY_FAILED"
  | "REQUIRED_MODEL_FIELD_MISSING"
  | "CAPABILITY_UNKNOWN"
  | "STRICT_SYNC_UNPROVEN"
  | "OWNERSHIP_CONFLICT"
  | "ADDON_CONFLICT"
  | "CONFIG_CHANGED"
  | "RECOVERY_REQUIRED"
  | "LOCK_TIMEOUT"
  | "UNSAFE_TARGET"
  | "TARGET_VERSION_CONFLICT"
  | "TARGET_ENV_MISMATCH"
  | "ENV_REFERENCE_UNRESOLVED"
  | "CREDENTIAL_UNAVAILABLE"
  | "CREDENTIAL_MISMATCH"
  | "NETWORK_POLICY_DENIED"
  | "UNPARSEABLE_CONFIG";

export type ConfigKitPhase =
  | "plan"
  | "resolve"
  | "network"
  | "parse"
  | "validate"
  | "lock"
  | "read"
  | "write"
  | "commit"
  | "inspect"
  | "recover";

export type AgentId =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "opencode"
  | "pi"
  | "deepseek-harness";

export interface ConfigKitErrorContext {
  code: ConfigKitErrorCode;
  message: string;
  agent?: AgentId;
  phase?: ConfigKitPhase;
  path?: string;
  field?: string;
  retryable?: boolean;
  replanRequired?: boolean;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class ConfigKitError extends Error {
  readonly code: ConfigKitErrorCode;
  readonly agent?: AgentId;
  readonly phase?: ConfigKitPhase;
  readonly path?: string;
  readonly field?: string;
  readonly retryable: boolean;
  readonly replanRequired: boolean;
  readonly details?: Record<string, unknown>;

  constructor(context: ConfigKitErrorContext) {
    super(context.message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = "ConfigKitError";
    this.code = context.code;
    if (context.agent !== undefined) this.agent = context.agent;
    if (context.phase !== undefined) this.phase = context.phase;
    if (context.path !== undefined) this.path = context.path;
    if (context.field !== undefined) this.field = context.field;
    this.retryable = context.retryable ?? false;
    this.replanRequired = context.replanRequired ?? false;
    if (context.details !== undefined) this.details = context.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      agent: this.agent,
      phase: this.phase,
      path: this.path,
      field: this.field,
      retryable: this.retryable,
      replanRequired: this.replanRequired,
      details: this.details,
    };
  }
}

export function isConfigKitError(value: unknown): value is ConfigKitError {
  return value instanceof ConfigKitError;
}