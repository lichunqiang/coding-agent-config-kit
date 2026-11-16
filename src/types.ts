import type { AgentId, ConfigKitError } from "./errors.js";

export type { AgentId } from "./errors.js";
export { ConfigKitError, isConfigKitError } from "./errors.js";
export type { ConfigKitErrorCode, ConfigKitPhase } from "./errors.js";

export type Protocol =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "google-generative-ai";

export type PlacementKind = "agent-file" | "env-reference" | "external-env";

export type CapabilityName =
  | "contextWindow"
  | "maxOutputTokens"
  | "reasoning"
  | "reasoningEfforts"
  | "inputModalities"
  | "toolCalling";

export type CapabilitySource = "user" | "provider" | "models.dev" | "unknown";

export interface Sourced<T> {
  value: T;
  source: CapabilitySource;
  asOf?: string;
}

export interface ModelCapabilities {
  contextWindow?: Sourced<number>;
  maxOutputTokens?: Sourced<number>;
  reasoning?: Sourced<boolean>;
  reasoningEfforts?: Sourced<string[]>;
  inputModalities?: Sourced<string[]>;
  toolCalling?: Sourced<boolean>;
}

export interface ModelCapabilityOverrides {
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  reasoningEfforts?: string[];
  inputModalities?: string[];
  toolCalling?: boolean;
}

export interface ResolvedModel {
  requestId: string;
  metadataId?: string;
  displayName: string;
  capabilities: ModelCapabilities;
  /** Capability fields dropped because the target cannot express them. */
  notProjectable: CapabilityName[];
}

export interface LaunchEnvironment {
  [key: string]: string | undefined;
}

export type ConfigFormat = "v1" | "v2";

export interface Target {
  /** Absolute config directory. Takes precedence over launchEnvironment. */
  configDir?: string;
  /** Environment the target agent will actually start with (not this process). */
  launchEnvironment?: LaunchEnvironment;
  projectDir?: string;
  agentVersion?: string;
  configFormat?: ConfigFormat;
  /** Explicit consent to execute the adapter's read-only version probe. */
  versionProbe?: { executable: string };
  /** DeepSeek Harness profile, required for that agent. */
  profile?: string;
}

export type CredentialSource =
  | { kind: "reference"; id: string; version?: string }
  | { kind: "inline"; value: string };

export type CredentialPlacement =
  | { kind: "agent-file" }
  | { kind: "env-reference"; envVar: string }
  | { kind: "external-env"; envVar: string };

export interface CredentialSpec {
  source: CredentialSource;
  placement: CredentialPlacement;
}

export interface ProviderSpec {
  /** Stable provider ID inside the target agent. */
  id: string;
  protocol: Protocol;
  /** Inference endpoint. */
  baseUrl: string;
  displayName?: string;
  credential: CredentialSpec;
  headers?: Record<string, string>;
}

export type DiscoveryEndpoint =
  | { kind: "protocol-default" }
  | { kind: "absolute-url"; url: string }
  | { kind: "relative-path"; path: string };

export type DiscoveryResponseFormat =
  | "openai-model-list"
  | "anthropic-model-list"
  | "google-model-list"
  | {
      kind: "custom";
      name: string;
      parse: (body: unknown) => NormalizedModelEntry[];
      completeness?: "complete" | "partial" | "unknown";
    };

export interface NormalizedModelEntry {
  requestId: string;
  displayName?: string;
  capabilities?: Partial<ModelCapabilityOverrides>;
}

export type DiscoveryCredential =
  | { kind: "use-provider" }
  | { kind: "reference"; id: string }
  | { kind: "none" };

export interface NetworkPolicy {
  allowPrivateNetwork?: boolean;
  allowedHosts?: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxPages?: number;
}

export interface DiscoverySpec {
  endpoint?: DiscoveryEndpoint;
  responseFormat?: DiscoveryResponseFormat;
  credential?: DiscoveryCredential;
  network?: NetworkPolicy;
}

export type ModelMetadataMode = "write" | "suggest" | "ignore";
export type SyncMode = "incremental" | "strict";
export type MetadataSource = "snapshot" | "live";

export interface ModelsSpec {
  discovery?: DiscoverySpec;
  fallbackIds?: string[];
  /** requestId -> models.dev model ID (may carry a vendor/namespace prefix). */
  aliases?: Record<string, string>;
  /** models.dev namespace hint used when the alias has no prefix. */
  metadataProvider?: string;
  metadataSource?: MetadataSource;
  overrides?: Record<string, ModelCapabilityOverrides>;
  metadata?: ModelMetadataMode;
  sync?: SyncMode;
  confirmDeletions?: boolean;
  unknownCapabilities?: "warn" | "block";
}

export interface OwnershipOptions {
  /** Provider/model IDs to take over when a same-named, unowned entry exists. */
  adopt?: string[];
  /** Credential field paths to take over explicitly (for example "company.apiKey"). */
  adoptCredentialFields?: string[];
}

export interface ModelRemoval {
  providerId: string;
  modelIds: string[];
}

export interface LifecycleOptions {
  removeProviders?: string[];
  removeModels?: Record<string, string[]>;
  unsetDefaultModel?: boolean;
}

export type DefaultSlot = "opus" | "sonnet" | "haiku";

export type SemanticIntent =
  | { kind: "setDefaultModel"; modelId: string; slots?: Partial<Record<DefaultSlot, string>> }
  | { kind: "unsetDefaultModel" }
  | { kind: "removeProvider"; providerId: string }
  | { kind: "removeModel"; providerId: string; modelIds: string[] };

export interface AddonContext {
  agent: AgentId;
  target: Target;
  models: ResolvedModel[];
  /** Adapter-declared capabilities, e.g. supported default-model slots. */
  adapter: {
    supportsDefaultSlots: boolean;
    placements: PlacementKind[];
  };
}

export interface AddonResult {
  intents: SemanticIntent[];
  warnings?: Diagnostic[];
}

export interface ConfigKitAddon {
  name: string;
  apply(context: AddonContext): AddonResult | Promise<AddonResult>;
}

export interface DefaultModelAddonOptions {
  modelId: string;
  claudeCode?: { slots?: Partial<Record<DefaultSlot, string>> };
}

export interface Diagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  field?: string;
  path?: string;
}

export type EffectivenessLevel = "confirmed" | "may-be-overridden" | "unknown";

export interface EffectivenessLayer {
  name: string;
  observed: "absent" | "present" | "unknown";
  note?: string;
}

export interface EffectivenessPreview {
  level: EffectivenessLevel;
  reasons: string[];
  layers: EffectivenessLayer[];
}

export interface FileChangePreview {
  path: string;
  kind: "create" | "update" | "delete" | "unchanged";
  beforeExists: boolean;
  redactedDiff?: string;
}

export interface TargetPreview {
  agent: AgentId;
  configDir: string;
  profile?: string;
  files: string[];
}

export interface ProviderPreview {
  id: string;
  protocol: Protocol;
  baseUrl: string;
}

export interface CredentialPreview {
  placement: PlacementKind;
  sourceKind: "reference" | "inline";
  envVar?: string;
}

export interface ModelPreview {
  requestId: string;
  metadataId?: string;
  displayName: string;
  capabilities: Record<string, { value: unknown; source: CapabilitySource; asOf?: string }>;
  notProjectable: CapabilityName[];
}

export interface MetadataPreview {
  source: MetadataSource;
  provider?: string;
  generatedAt?: string;
  fetchedAt?: string;
  stale: boolean;
}

export interface DiscoveryPreview {
  status: "available" | "unsupported" | "failed" | "skipped";
  completeness: "complete" | "partial" | "unknown";
  modelsFound: number;
  usedFallback: boolean;
  endpoint?: string;
  asOf?: string;
}

export interface IntentPreview {
  kind: string;
  summary: string;
}

export interface OwnershipPreview {
  adopted: string[];
  conflicts: string[];
}

export interface LifecyclePreview {
  removeProviders: string[];
  removeModels: Record<string, string[]>;
  unsetDefaultModel: boolean;
}

export interface Preview {
  previewSchemaVersion: 1;
  target: TargetPreview;
  provider?: ProviderPreview;
  credential?: CredentialPreview;
  models: ModelPreview[];
  metadata: MetadataPreview;
  discovery: DiscoveryPreview;
  intents: IntentPreview[];
  changes: FileChangePreview[];
  ownership: OwnershipPreview;
  lifecycle: LifecyclePreview;
  effectiveness: EffectivenessPreview;
  warnings: Diagnostic[];
  blockers: Diagnostic[];
}

export type ApplyStatus =
  | "applied"
  | "unchanged"
  | "locked"
  | "restored"
  | "recovery-required"
  | "manual-intervention"
  | "failed";

export interface AppliedFile {
  path: string;
  action: "created" | "updated" | "unchanged" | "deleted";
}

export interface ApplyEffects {
  defaultModelChanged: boolean;
  currentConnectionChanged: boolean;
}

export interface AppliedResult {
  status: ApplyStatus;
  transactionId?: string;
  files: AppliedFile[];
  effects: ApplyEffects;
  warnings: Diagnostic[];
  error?: ConfigKitError;
}

export interface LockInspection {
  held: boolean;
  holder?: {
    transactionId: string;
    pid: number;
    hostname: string;
    startedAt: string;
    ageMs: number;
  };
  corrupt?: boolean;
  path?: string;
}

export interface RecoveryInspection {
  pending: boolean;
  record?: {
    transactionId: string;
    status: "prepared" | "committing" | "committed";
    createdAt: string;
    ageMs: number;
    files: string[];
  };
  lock: LockInspection;
}

export interface ResolveAndPlanRequest {
  agent: AgentId;
  target: Target;
  provider?: ProviderSpec;
  models?: ModelsSpec;
  ownership?: OwnershipOptions;
  lifecycle?: LifecycleOptions;
}

export interface Plan {
  readonly preview: Preview;
  dispose(): void;
}

export interface RecoverOptions {
  mode?: "auto" | "complete" | "restore-old" | "break-stale-lock";
}

export interface InspectRecoveryRequest {
  agent: AgentId;
  target: Target;
}

export interface ApplyOptions {
  confirmDeletions?: boolean;
}

export interface ConfigKitOptions {
  ownerId: string;
  resolveCredential: (ref: string) => Promise<string> | string;
  addons?: ConfigKitAddon[];
  lock?: { timeoutMs?: number; staleMs?: number };
  journalTtlMs?: number;
}

export interface ConfigKit {
  resolveAndPlan(request: ResolveAndPlanRequest): Promise<Plan>;
  apply(plan: Plan, options?: ApplyOptions): Promise<AppliedResult>;
  inspectRecovery(request: InspectRecoveryRequest): Promise<RecoveryInspection>;
  recover(request: InspectRecoveryRequest, options?: RecoverOptions): Promise<AppliedResult>;
}