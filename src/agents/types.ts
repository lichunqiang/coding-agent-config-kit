import type {
  AgentId,
  ApplyEffects,
  CapabilityName,
  Diagnostic,
  EffectivenessPreview,
  IntentPreview,
  LifecycleOptions,
  ModelMetadataMode,
  OwnershipOptions,
  PlacementKind,
  Protocol,
  ProviderSpec,
  ResolvedModel,
  SemanticIntent,
  Target,
} from "../types.js";
import type { ManagementRecord } from "../internal/state.js";
import type { ResolvedTarget } from "./target.js";

export interface PlannedFile {
  path: string;
  before: string | null;
  after: string | null;
  mode?: number;
}

export interface AgentPlan {
  files: PlannedFile[];
  intents: IntentPreview[];
  effects: ApplyEffects;
  effectiveness: EffectivenessPreview;
  warnings: Diagnostic[];
  blockers: Diagnostic[];
  state: ManagementRecord;
  adopted: string[];
  ownershipConflicts: string[];
  /** Owned models that strict sync would delete. */
  deletions: string[];
  /** Values that must never appear verbatim in a preview. */
  redactions: string[];
}

export interface AgentBuildInput {
  target: Target;
  resolved: ResolvedTarget;
  provider?: ProviderSpec;
  credentialValue?: string;
  models: ResolvedModel[];
  metadataMode: ModelMetadataMode;
  discoveryCompleteness: "complete" | "partial" | "unknown";
  usedFallback: boolean;
  intents: SemanticIntent[];
  lifecycle: LifecycleOptions;
  confirmDeletions: boolean;
  state: ManagementRecord | null;
  ownership: OwnershipOptions;
  ownerId: string;
  strict: boolean;
  now: Date;
}

export interface AgentAdapter {
  id: AgentId;
  protocols: readonly Protocol[];
  placements: readonly PlacementKind[];
  supportsDefaultSlots: boolean;
  projectable: ReadonlySet<CapabilityName>;
  agentDefaults?: Partial<Record<CapabilityName, unknown>>;
  buildPlan(input: AgentBuildInput): Promise<AgentPlan>;
}