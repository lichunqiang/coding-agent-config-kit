import { randomUUID } from "node:crypto";

import { ConfigKitError, type ConfigKitErrorCode } from "./errors.js";
import { getAdapter } from "./agents/registry.js";
import { resolveAgentTarget, type ResolvedTarget } from "./agents/target.js";
import type { AgentAdapter, AgentPlan, PlannedFile } from "./agents/types.js";
import { diffLines, redactSecrets } from "./editing/text.js";
import {
  atomicWriteFile,
  ensurePrivateDir,
  fingerprintFile,
  readFileIfExists,
  removeFileIfExists,
  type FileFingerprint,
} from "./internal/fs.js";
import { kitPaths, statePathForOwner } from "./internal/paths.js";
import { sha256, stableStringify } from "./internal/hash.js";
import {
  breakStaleLock,
  inspectLock,
  TargetLock,
} from "./internal/lock.js";
import {
  isJournalExpired,
  journalAgeMs,
  readJournalIfExists,
  removeJournal,
  updateJournalStatus,
  writeJournal,
  type ContentSnapshot,
  type JournalFile,
  type RecoveryRecord,
} from "./internal/journal.js";
import {
  readManagement,
  type ManagementRecord,
} from "./internal/state.js";
import { discoverModels } from "./models/discovery.js";
import {
  isSnapshotStale,
  loadMetadata,
  type MetadataCatalog,
} from "./models/metadata.js";
import { resolveModels } from "./models/resolve.js";
import type {
  AgentId,
  AppliedFile,
  AppliedResult,
  ApplyOptions,
  CapabilityName,
  CapabilitySource,
  ConfigKit,
  ConfigKitOptions,
  CredentialPreview,
  CredentialSource,
  Diagnostic,
  DiscoveryPreview,
  FileChangePreview,
  InspectRecoveryRequest,
  LifecycleOptions,
  MetadataPreview,
  ModelPreview,
  OwnershipOptions,
  Plan,
  Preview,
  ProviderSpec,
  RecoverOptions,
  RecoveryInspection,
  ResolveAndPlanRequest,
  ResolvedModel,
  SemanticIntent,
} from "./types.js";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 10 * 60_000;
const DEFAULT_JOURNAL_TTL_MS = 60 * 60_000;

interface InternalPlan {
  adapter: AgentAdapter;
  request: ResolveAndPlanRequest;
  resolved: ResolvedTarget;
  files: PlannedFile[];
  stateBefore: string | null;
  stateAfter: string | null;
  statePath: string;
  deletions: string[];
  credentialSource?: CredentialSource;
  credentialHash?: string;
  warnings: Diagnostic[];
  blockers: Diagnostic[];
  effects: AgentPlan["effects"];
}

class PlanImpl implements Plan {
  readonly preview: Preview;
  private internal: InternalPlan | null;

  constructor(preview: Preview, internal: InternalPlan) {
    this.preview = preview;
    this.internal = internal;
  }

  dispose(): void {
    this.internal = null;
  }

  take(): InternalPlan {
    if (this.internal === null) {
      throw new ConfigKitError({
        code: "UNSUPPORTED_INTENT",
        message: "Plan has been disposed and can no longer be applied",
        phase: "validate",
      });
    }
    return this.internal;
  }
}

export function createConfigKit(options: ConfigKitOptions): ConfigKit {
  if (options.ownerId === undefined || options.ownerId === "") {
    throw new ConfigKitError({
      code: "UNSAFE_TARGET",
      message: "ownerId must be a stable non-empty application ID",
      phase: "validate",
      field: "ownerId",
    });
  }
  return new ConfigKitImpl(options);
}

class ConfigKitImpl implements ConfigKit {
  constructor(private readonly options: ConfigKitOptions) {}

  async resolveAndPlan(request: ResolveAndPlanRequest): Promise<Plan> {
    if (request.provider === undefined && request.lifecycle === undefined) {
      throw new ConfigKitError({
        code: "UNSUPPORTED_INTENT",
        message: "Provide a provider or a lifecycle operation",
        agent: request.agent,
        phase: "validate",
      });
    }

    const adapter = getAdapter(request.agent);
    if (request.provider !== undefined) {
      if (!adapter.protocols.includes(request.provider.protocol)) {
        throw new ConfigKitError({
          code: "UNSUPPORTED_PROTOCOL",
          message: `${request.agent} does not support ${request.provider.protocol} for direct inference`,
          agent: request.agent,
          phase: "validate",
          field: "provider.protocol",
        });
      }
      if (!adapter.placements.includes(request.provider.credential.placement.kind)) {
        throw new ConfigKitError({
          code: "UNSUPPORTED_INTENT",
          message: `${request.agent} does not support ${request.provider.credential.placement.kind} credentials`,
          agent: request.agent,
          phase: "validate",
          field: "provider.credential.placement",
        });
      }
    }

    const resolved = await resolveAgentTarget(request.agent, request.target);
    const warnings: Diagnostic[] = [...resolved.warnings];
    const blockers: Diagnostic[] = [...resolved.blockers];

    this.checkEnvironment(request, blockers);

    const modelsSpec = request.models;
    const discovery = modelsSpec?.discovery;

    let providerSecret: string | undefined;
    if (request.provider !== undefined) {
      const placement = request.provider.credential.placement;
      const needsSecret =
        placement.kind === "agent-file" ||
        discovery?.credential?.kind === "use-provider" ||
        discovery?.credential === undefined;
      if (needsSecret && discovery !== undefined) {
        providerSecret = await this.resolveSource(request.provider.credential.source);
      } else if (placement.kind === "agent-file") {
        providerSecret = await this.resolveSource(request.provider.credential.source);
      }
    }

    let entries: Awaited<ReturnType<typeof discoverModels>>["entries"] | null = null;
    let discoveryStatus: DiscoveryPreview["status"] =
      discovery === undefined ? "skipped" : "failed";
    let completeness: DiscoveryPreview["completeness"] = "unknown";
    let endpoint: string | undefined;
    let asOf: string | undefined;
    let usedFallback = false;

    if (discovery !== undefined) {
      let discoveryKey: string | undefined;
      if (discovery.credential?.kind === "reference") {
        discoveryKey = await this.resolveSource({
          kind: "reference",
          id: discovery.credential.id,
        });
      } else if (discovery.credential?.kind !== "none") {
        discoveryKey = providerSecret;
      }

      try {
        const discovered = await discoverModels({
          baseUrl: request.provider?.baseUrl ?? "",
          protocol: request.provider?.protocol ?? "openai-completions",
          ...(discoveryKey === undefined ? {} : { apiKey: discoveryKey }),
          ...(discovery.endpoint === undefined ? {} : { endpoint: discovery.endpoint }),
          ...(discovery.responseFormat === undefined
            ? {}
            : { responseFormat: discovery.responseFormat }),
          ...(discovery.credential === undefined
            ? {}
            : { credential: discovery.credential }),
          ...(discovery.network === undefined ? {} : { network: discovery.network }),
        });
        entries = discovered.entries;
        completeness = discovered.completeness;
        endpoint = discovered.endpoint;
        asOf = discovered.asOf;
        discoveryStatus = "available";
      } catch (error) {
        if ((modelsSpec?.fallbackIds?.length ?? 0) > 0) {
          usedFallback = true;
          discoveryStatus = "failed";
          warnings.push({
            code: "MODEL_DISCOVERY_FALLBACK",
            severity: "warning",
            message: "Model discovery failed; fallback IDs will be used",
            ...(error instanceof Error ? { message: error.message } : {}),
          });
        } else {
          throw error;
        }
      }
    }

    const fallbackIds = modelsSpec?.fallbackIds ?? [];
    if (discovery === undefined && fallbackIds.length > 0) usedFallback = true;

    let catalog: MetadataCatalog | undefined;
    if (modelsSpec?.metadata !== "ignore" && (entries !== null || fallbackIds.length > 0)) {
      catalog = await loadMetadata({
        source: modelsSpec?.metadataSource ?? "snapshot",
      });
      if (catalog.fallbackReason !== undefined) {
        warnings.push({
          code: "METADATA_LIVE_FALLBACK",
          severity: "warning",
          message: `Live models.dev retrieval failed; using the packaged snapshot (${catalog.fallbackReason})`,
        });
      }
      if (catalog.source === "snapshot" && isSnapshotStale(catalog)) {
        warnings.push({
          code: "MODELS_DEV_STALE",
          severity: "warning",
          message: `Packaged models.dev snapshot is older than 24h (${catalog.generatedAt ?? "unknown"})`,
        });
      }
    }

    let resolvedModels: ResolvedModel[] = [];
    if (entries !== null || fallbackIds.length > 0) {
      const resolution = resolveModels({
        agent: request.agent,
        entries,
        fallbackIds,
        usedFallback,
        ...(modelsSpec?.aliases === undefined ? {} : { aliases: modelsSpec.aliases }),
        ...(modelsSpec?.metadataProvider === undefined
          ? {}
          : { metadataProvider: modelsSpec.metadataProvider }),
        ...(modelsSpec?.metadata === undefined ? {} : { metadataMode: modelsSpec.metadata }),
        ...(modelsSpec?.overrides === undefined ? {} : { overrides: modelsSpec.overrides }),
        ...(catalog === undefined ? {} : { catalog }),
        projectable: adapter.projectable,
        ...(adapter.agentDefaults === undefined
          ? {}
          : { agentDefaults: adapter.agentDefaults }),
        ...(modelsSpec?.unknownCapabilities === undefined
          ? {}
          : { unknownPolicy: modelsSpec.unknownCapabilities }),
      });
      resolvedModels = resolution.models;
      warnings.push(...resolution.warnings);
      blockers.push(...resolution.blockers);
    }

    const intents: SemanticIntent[] =
      request.provider === undefined
        ? []
        : await this.runAddons(request, resolvedModels, adapter, warnings);

    const lifecycle: LifecycleOptions = request.lifecycle ?? {};
    const statePath = statePathForOwner(resolved.configDir, this.options.ownerId);
    const state = await readManagement(statePath);
    const stateBefore = (await readFileIfExists(statePath))?.toString("utf8") ?? null;

    const adapterPlan: AgentPlan = await adapter.buildPlan({
      target: request.target,
      resolved,
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(providerSecret === undefined ? {} : { credentialValue: providerSecret }),
      models: resolvedModels,
      metadataMode: modelsSpec?.metadata ?? "write",
      discoveryCompleteness: completeness,
      usedFallback,
      intents,
      lifecycle,
      confirmDeletions: true,
      state,
      ownership: request.ownership ?? {},
      ownerId: this.options.ownerId,
      strict: modelsSpec?.sync === "strict",
      now: new Date(),
    });

    warnings.push(...adapterPlan.warnings);
    blockers.push(...adapterPlan.blockers);

    const preview = buildPreview({
      request,
      resolved,
      adapterPlan,
      models: resolvedModels,
      catalog,
      discovery: {
        status: discoveryStatus,
        completeness,
        modelsFound: resolvedModels.length,
        usedFallback,
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(asOf === undefined ? {} : { asOf }),
      },
      warnings,
      blockers,
      redactions: adapterPlan.redactions,
    });

    const stateEntriesChanged =
      stableStringify(adapterPlan.state.entries) !== stableStringify(state?.entries ?? {});
    const stateAfter = stateEntriesChanged
      ? `${JSON.stringify(adapterPlan.state, null, 2)}\n`
      : stateBefore;
    const credential =
      request.provider?.credential.placement.kind === "agent-file" && providerSecret !== undefined
        ? {
            source: request.provider.credential.source,
            hash: sha256(providerSecret),
          }
        : undefined;

    return new PlanImpl(preview, {
      adapter,
      request,
      resolved,
      files: adapterPlan.files,
      stateBefore,
      stateAfter,
      statePath,
      deletions: adapterPlan.deletions,
      ...(credential === undefined
        ? {}
        : { credentialSource: credential.source, credentialHash: credential.hash }),
      warnings,
      blockers,
      effects: adapterPlan.effects,
    });
  }

  async apply(plan: Plan, applyOptions: ApplyOptions = {}): Promise<AppliedResult> {
    if (!(plan instanceof PlanImpl)) {
      throw new ConfigKitError({
        code: "UNSAFE_TARGET",
        message: "apply() requires a plan created by this SDK instance",
        phase: "validate",
      });
    }
    const internal = plan.take();

    if (internal.blockers.length > 0) {
      return failedResult(internal.blockers[0]!, [], internal.warnings);
    }
    if (internal.deletions.length > 0 && applyOptions.confirmDeletions !== true) {
      return failedResult(
        {
          code: "STRICT_SYNC_UNPROVEN",
          severity: "error",
          message: `Strict sync would delete ${internal.deletions.length} model(s); pass confirmDeletions to proceed`,
        },
        [],
        internal.warnings,
      );
    }

    const lockPath = kitPaths(internal.resolved.configDir).lock;
    await ensurePrivateDir(kitPaths(internal.resolved.configDir).dir);

    let lock: TargetLock;
    try {
      lock = await TargetLock.acquire(lockPath, {
        timeoutMs: this.options.lock?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
        staleMs: this.options.lock?.staleMs ?? DEFAULT_LOCK_STALE_MS,
      });
    } catch (error) {
      if (error instanceof ConfigKitError && error.code === "LOCK_TIMEOUT") {
        return {
          status: "locked",
          files: [],
          effects: { defaultModelChanged: false, currentConnectionChanged: false },
          warnings: internal.warnings,
          error,
        };
      }
      throw error;
    }

    try {
      const journalPath = kitPaths(internal.resolved.configDir).recovery;
      const pending = await readJournalIfExists(journalPath);
      if (pending !== null) {
        throw new ConfigKitError({
          code: "RECOVERY_REQUIRED",
          message: "A recovery record exists; run inspectRecovery/recover first",
          phase: "commit",
          path: journalPath,
          replanRequired: true,
        });
      }

      await this.assertPlanStillValid(internal);

      const changes = internal.files.filter((file) => file.before !== file.after);
      const stateChanged = internal.stateAfter !== internal.stateBefore;
      if (changes.length === 0 && !stateChanged) {
        return {
          status: "unchanged",
          files: internal.files.map((file) => ({
            path: file.path,
            action: file.before === null ? "unchanged" : "unchanged",
          })),
          effects: internal.effects,
          warnings: internal.warnings,
        };
      }

      const journalFiles: JournalFile[] = changes.map((file) =>
        journalFileFor(file.path, file.before, file.after),
      );
      if (stateChanged) {
        journalFiles.push(
          journalFileFor(
            internal.statePath,
            internal.stateBefore,
            internal.stateAfter,
          ),
        );
      }

      const record: RecoveryRecord = {
        schemaVersion: 1,
        transactionId: randomUUID(),
        ownerId: this.options.ownerId,
        agent: internal.request.agent,
        configDir: internal.resolved.configDir,
        status: "prepared",
        createdAt: new Date().toISOString(),
        files: journalFiles,
      };
      await writeJournal(journalPath, record);
      await updateJournalStatus(journalPath, "committing");

      const written: Array<{ file: PlannedFile; action: "created" | "updated" | "deleted" }> = [];
      try {
        for (const file of changes) {
          await ensurePrivateDir(parentOf(file.path));
          if (file.after === null) {
            await removeFileIfExists(file.path);
            written.push({ file, action: "deleted" });
          } else {
            await atomicWriteFile(file.path, file.after, { mode: file.mode ?? 0o600 });
            written.push({
              file,
              action: file.before === null ? "created" : "updated",
            });
          }
        }
        if (stateChanged) {
          await ensurePrivateDir(parentOf(internal.statePath));
          await atomicWriteFile(internal.statePath, internal.stateAfter ?? "", { mode: 0o600 });
        }
      } catch (error) {
        await restoreWritten(written);
        await removeJournal(journalPath);
        return {
          status: "restored",
          files: written.map(({ file, action }) => ({ path: file.path, action })),
          effects: internal.effects,
          warnings: internal.warnings,
          error:
            error instanceof ConfigKitError
              ? error
              : new ConfigKitError({
                  code: "UNSAFE_TARGET",
                  message: "Commit failed and previous contents were restored",
                  phase: "commit",
                  cause: error,
                }),
        };
      }

      await updateJournalStatus(journalPath, "committed");
      await removeJournal(journalPath);

      const files: AppliedFile[] = internal.files.map((file) => ({
        path: file.path,
        action:
          file.before === file.after
            ? "unchanged"
            : file.after === null
              ? "deleted"
              : file.before === null
                ? "created"
                : "updated",
      }));

      return {
        status: "applied",
        transactionId: record.transactionId,
        files,
        effects: internal.effects,
        warnings: internal.warnings,
      };
    } catch (error) {
      if (error instanceof ConfigKitError) {
        const status =
          error.code === "RECOVERY_REQUIRED"
            ? "recovery-required"
            : "failed";
        return {
          status,
          files: [],
          effects: { defaultModelChanged: false, currentConnectionChanged: false },
          warnings: internal.warnings,
          error,
        };
      }
      throw error;
    } finally {
      await lock.release();
    }
  }

  async inspectRecovery(request: InspectRecoveryRequest): Promise<RecoveryInspection> {
    const resolved = await resolveAgentTarget(request.agent, request.target);
    const lock = await inspectLock(kitPaths(resolved.configDir).lock);
    let record: RecoveryRecord | null = null;
    try {
      record = await readJournalIfExists(kitPaths(resolved.configDir).recovery);
    } catch {
      return { pending: true, lock };
    }
    if (record === null) return { pending: false, lock };
    return {
      pending: true,
      record: {
        transactionId: record.transactionId,
        status: record.status,
        createdAt: record.createdAt,
        ageMs: journalAgeMs(record),
        files: record.files.map((file) => file.path),
      },
      lock,
    };
  }

  async recover(
    request: InspectRecoveryRequest,
    recoverOptions: RecoverOptions = {},
  ): Promise<AppliedResult> {
    const resolved = await resolveAgentTarget(request.agent, request.target);
    const mode = recoverOptions.mode ?? "auto";
    const lockPath = kitPaths(resolved.configDir).lock;

    if (mode === "break-stale-lock") {
      const broken = await breakStaleLock(lockPath, {
        staleMs: this.options.lock?.staleMs ?? DEFAULT_LOCK_STALE_MS,
      });
      return {
        status: "unchanged",
        files: [],
        effects: { defaultModelChanged: false, currentConnectionChanged: false },
        warnings: [
          {
            code: "LOCK_BROKEN",
            severity: "warning",
            message: broken.holder === undefined
              ? "Removed an unreadable stale lock"
              : `Removed stale lock held by pid ${broken.holder.pid}`,
          },
        ],
      };
    }

    const journalPath = kitPaths(resolved.configDir).recovery;
    const record = await readJournalIfExists(journalPath);
    if (record === null) {
      return {
        status: "unchanged",
        files: [],
        effects: { defaultModelChanged: false, currentConnectionChanged: false },
        warnings: [],
      };
    }

    const ttlMs = this.options.journalTtlMs ?? DEFAULT_JOURNAL_TTL_MS;
    if (isJournalExpired(record, ttlMs) && mode === "auto") {
      return {
        status: "manual-intervention",
        files: [],
        effects: { defaultModelChanged: false, currentConnectionChanged: false },
        warnings: [
          {
            code: "RECOVERY_EXPIRED",
            severity: "warning",
            message: "Recovery record is older than its TTL; refusing to act automatically",
          },
        ],
      };
    }

    let lock: TargetLock;
    try {
      lock = await TargetLock.acquire(lockPath, {
        timeoutMs: this.options.lock?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof ConfigKitError && error.code === "LOCK_TIMEOUT") {
        return {
          status: "locked",
          files: [],
          effects: { defaultModelChanged: false, currentConnectionChanged: false },
          warnings: [],
          error,
        };
      }
      throw error;
    }

    try {
      const targetMode = mode === "restore-old" ? "before" : "after";
      let restored = false;
      let completed = false;
      const files: AppliedFile[] = [];

      for (const file of record.files) {
        const current = await readFileIfExists(file.path);
        const target = targetMode === "before" ? file.before : file.after;
        const other = targetMode === "before" ? file.after : file.before;

        if (matchesSnapshot(current, target)) continue;

        if (!matchesSnapshot(current, other)) {
          return {
            status: "manual-intervention",
            files,
            effects: { defaultModelChanged: false, currentConnectionChanged: false },
            warnings: [
              {
                code: "RECOVERY_CONFLICT",
                severity: "error",
                message: `File ${file.path} has a third-party content; refusing to overwrite`,
              },
            ],
          };
        }

        const bytes = contentOf(target);
        if (bytes === null) {
          await removeFileIfExists(file.path);
        } else {
          await ensurePrivateDir(parentOf(file.path));
          await atomicWriteFile(file.path, bytes, { mode: 0o600 });
        }
        files.push({ path: file.path, action: target.exists ? "updated" : "deleted" });
        if (targetMode === "before") restored = true;
        else completed = true;
      }

      await removeJournal(journalPath);
      return {
        status: restored ? "restored" : completed ? "applied" : "unchanged",
        files,
        effects: { defaultModelChanged: false, currentConnectionChanged: false },
        warnings: [],
      };
    } finally {
      await lock.release();
    }
  }

  private async assertPlanStillValid(internal: InternalPlan): Promise<void> {
    for (const file of internal.files) {
      const fingerprint = await fingerprintFile(file.path);
      if (!matchesFingerprint(fingerprint, file.before)) {
        throw new ConfigKitError({
          code: "CONFIG_CHANGED",
          message: `Target file changed since planning: ${file.path}`,
          agent: internal.request.agent,
          phase: "commit",
          path: file.path,
          replanRequired: true,
        });
      }
    }
    const currentState = (await readFileIfExists(internal.statePath))?.toString("utf8") ?? null;
    if (currentState !== internal.stateBefore) {
      throw new ConfigKitError({
        code: "CONFIG_CHANGED",
        message: "Management record changed since planning",
        agent: internal.request.agent,
        phase: "commit",
        path: internal.statePath,
        replanRequired: true,
      });
    }
    if (internal.credentialSource !== undefined && internal.credentialHash !== undefined) {
      const current = await this.resolveSource(internal.credentialSource);
      if (sha256(current) !== internal.credentialHash) {
        throw new ConfigKitError({
          code: "CREDENTIAL_MISMATCH",
          message: "Credential changed since planning",
          agent: internal.request.agent,
          phase: "commit",
          replanRequired: true,
        });
      }
    }
  }

  private async resolveSource(source: CredentialSource): Promise<string> {
    if (source.kind === "inline") return source.value;
    try {
      const value = await this.options.resolveCredential(source.id);
      if (value === undefined || value === "") {
        throw new Error("credential resolver returned an empty value");
      }
      return value;
    } catch (error) {
      throw new ConfigKitError({
        code: "CREDENTIAL_UNAVAILABLE",
        message: `Unable to resolve credential reference ${source.id}`,
        phase: "resolve",
        cause: error,
      });
    }
  }

  private async runAddons(
    request: ResolveAndPlanRequest,
    models: ResolvedModel[],
    adapter: AgentAdapter,
    warnings: Diagnostic[],
  ): Promise<SemanticIntent[]> {
    const intents: SemanticIntent[] = [];
    for (const addon of this.options.addons ?? []) {
      const result = await addon.apply({
        agent: request.agent,
        target: request.target,
        models,
        adapter: {
          supportsDefaultSlots: adapter.supportsDefaultSlots,
          placements: [...adapter.placements],
        },
      });
      intents.push(...result.intents);
      if (result.warnings !== undefined) warnings.push(...result.warnings);
    }
    if (intents.filter((intent) => intent.kind === "setDefaultModel").length > 1) {
      throw new ConfigKitError({
        code: "ADDON_CONFLICT",
        message: "Multiple add-ons set the default model",
        agent: request.agent,
        phase: "plan",
      });
    }
    return intents;
  }

  private checkEnvironment(
    request: ResolveAndPlanRequest,
    blockers: Diagnostic[],
  ): void {
    const placement = request.provider?.credential.placement;
    if (placement === undefined) return;
    if (placement.kind !== "env-reference" && placement.kind !== "external-env") return;
    const value = request.target.launchEnvironment?.[placement.envVar];
    if (value === undefined || value === "") {
      blockers.push({
        code: "ENV_REFERENCE_UNRESOLVED",
        severity: "error",
        message: `${placement.envVar} is not present in the target launch environment`,
        field: `provider.credential.placement.${placement.envVar}`,
      });
    }
  }
}

function buildPreview(input: {
  request: ResolveAndPlanRequest;
  resolved: ResolvedTarget;
  adapterPlan: AgentPlan;
  models: ResolvedModel[];
  catalog: MetadataCatalog | undefined;
  discovery: DiscoveryPreview;
  warnings: Diagnostic[];
  blockers: Diagnostic[];
  redactions: string[];
}): Preview {
  const target = {
    agent: input.request.agent,
    configDir: input.resolved.configDir,
    files: input.adapterPlan.files.map((file) => file.path),
    ...(input.resolved.profile === undefined ? {} : { profile: input.resolved.profile }),
  };

  const changes: FileChangePreview[] = input.adapterPlan.files.map((file) => {
    const kind: FileChangePreview["kind"] =
      file.before === null
        ? file.after === null
          ? "unchanged"
          : "create"
        : file.after === null
          ? "delete"
          : file.before === file.after
            ? "unchanged"
            : "update";
    const preview: FileChangePreview = {
      path: file.path,
      kind,
      beforeExists: file.before !== null,
    };
    if (kind === "create" || kind === "update" || kind === "delete") {
      preview.redactedDiff = redactSecrets(
        diffLines(file.before ?? "", file.after ?? ""),
        input.redactions,
      );
    }
    return preview;
  });

  const metadata = metadataPreview(input.catalog, input.request);
  const lifecycle = input.request.lifecycle ?? {};

  return {
    previewSchemaVersion: 1,
    target,
    ...(input.request.provider === undefined
      ? {}
      : {
          provider: {
            id: input.request.provider.id,
            protocol: input.request.provider.protocol,
            baseUrl: input.request.provider.baseUrl,
          },
        }),
    ...(input.request.provider === undefined
      ? {}
      : { credential: credentialPreview(input.request.provider) }),
    models: input.models.map(modelPreview),
    metadata,
    discovery: input.discovery,
    intents: input.adapterPlan.intents,
    changes,
    ownership: {
      adopted: input.adapterPlan.adopted,
      conflicts: input.adapterPlan.ownershipConflicts,
    },
    lifecycle: {
      removeProviders: lifecycle.removeProviders ?? [],
      removeModels: lifecycle.removeModels ?? {},
      unsetDefaultModel: lifecycle.unsetDefaultModel === true,
    },
    effectiveness: input.adapterPlan.effectiveness,
    warnings: input.warnings,
    blockers: input.blockers,
  };
}

function credentialPreview(provider: ProviderSpec): CredentialPreview {
  const placement = provider.credential.placement;
  const base = {
    placement: placement.kind,
    sourceKind: provider.credential.source.kind,
  };
  if (placement.kind === "agent-file") return base;
  return { ...base, envVar: placement.envVar };
}

function metadataPreview(
  catalog: MetadataCatalog | undefined,
  request: ResolveAndPlanRequest,
): MetadataPreview {
  const source = request.models?.metadataSource ?? "snapshot";
  return {
    source: catalog?.source ?? source,
    ...(request.models?.metadataProvider === undefined
      ? {}
      : { provider: request.models.metadataProvider }),
    ...(catalog?.generatedAt === undefined ? {} : { generatedAt: catalog.generatedAt }),
    ...(catalog?.fetchedAt === undefined ? {} : { fetchedAt: catalog.fetchedAt }),
    stale: catalog === undefined ? false : catalog.source === "snapshot" && isSnapshotStale(catalog),
  };
}

function modelPreview(model: ResolvedModel): ModelPreview {
  const capabilities: ModelPreview["capabilities"] = {};
  for (const [name, sourced] of Object.entries(model.capabilities)) {
    if (sourced === undefined) continue;
    capabilities[name] = {
      value: sourced.value,
      source: sourced.source as CapabilitySource,
      ...(sourced.asOf === undefined ? {} : { asOf: sourced.asOf }),
    };
  }
  return {
    requestId: model.requestId,
    ...(model.metadataId === undefined ? {} : { metadataId: model.metadataId }),
    displayName: model.displayName,
    capabilities,
    notProjectable: model.notProjectable,
  };
}

function journalFileFor(
  path: string,
  before: string | null,
  after: string | null,
): JournalFile {
  return {
    path,
    before: snapshotOf(before),
    after: snapshotOf(after),
  };
}

function snapshotOf(text: string | null): ContentSnapshot {
  if (text === null) return { exists: false };
  return {
    exists: true,
    sha256: sha256(text),
    contentBase64: Buffer.from(text, "utf8").toString("base64"),
  };
}

function matchesFingerprint(fingerprint: FileFingerprint, before: string | null): boolean {
  if (before === null) return !fingerprint.exists;
  return fingerprint.exists && fingerprint.sha256 === sha256(before);
}

function matchesSnapshot(current: Buffer | null, snapshot: ContentSnapshot): boolean {
  if (!snapshot.exists) return current === null;
  if (current === null) return false;
  return sha256(current) === snapshot.sha256;
}

function contentOf(snapshot: ContentSnapshot): Buffer | null {
  if (!snapshot.exists) return null;
  if (snapshot.contentBase64 === undefined) {
    throw new ConfigKitError({
      code: "UNPARSEABLE_CONFIG",
      message: "Recovery record is missing stored content",
      phase: "recover",
    });
  }
  return Buffer.from(snapshot.contentBase64, "base64");
}

async function restoreWritten(
  written: Array<{ file: PlannedFile }>,
): Promise<void> {
  for (const { file } of [...written].reverse()) {
    try {
      if (file.before === null) {
        await removeFileIfExists(file.path);
      } else {
        await atomicWriteFile(file.path, file.before, { mode: file.mode ?? 0o600 });
      }
    } catch {
      // Best effort: the journal remains for the next recovery attempt.
    }
  }
}

function failedResult(
  blocker: Diagnostic,
  files: AppliedFile[],
  warnings: Diagnostic[],
): AppliedResult {
  return {
    status: "failed",
    files,
    effects: { defaultModelChanged: false, currentConnectionChanged: false },
    warnings,
    error: new ConfigKitError({
      code: blocker.code as ConfigKitErrorCode,
      message: blocker.message,
      phase: blocker.code === "STRICT_SYNC_UNPROVEN" ? "commit" : "plan",
      ...(blocker.field === undefined ? {} : { field: blocker.field }),
      ...(blocker.path === undefined ? {} : { path: blocker.path }),
    }),
  };
}

function parentOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? "." : path.slice(0, index);
}