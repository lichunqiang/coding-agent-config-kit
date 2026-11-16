import { randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { hostname as osHostname } from "node:os";

import { ConfigKitError } from "../errors.js";
import type { LockInspection } from "../types.js";
import { isCode, removeFileIfExists, wrapIoError } from "./fs.js";

export interface LockHolder {
  transactionId: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

export interface AcquireLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  now?: () => number;
}

export interface BreakStaleLockOptions {
  staleMs?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 10 * 60_000;

export class TargetLock {
  readonly path: string;
  readonly holder: LockHolder;

  private constructor(path: string, holder: LockHolder) {
    this.path = path;
    this.holder = holder;
  }

  static async acquire(path: string, options: AcquireLockOptions = {}): Promise<TargetLock> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const now = options.now ?? Date.now;
    const deadline = now() + timeoutMs;

    for (;;) {
      const holder: LockHolder = {
        transactionId: randomUUID(),
        pid: process.pid,
        hostname: osHostname(),
        startedAt: new Date(now()).toISOString(),
      };
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(holder)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        const reread = await readLockHolder(path);
        if (reread === null || reread.transactionId !== holder.transactionId) {
          throw new ConfigKitError({
            code: "LOCK_TIMEOUT",
            message: "Lock content changed immediately after creation",
            phase: "lock",
            path,
            retryable: true,
          });
        }
        return new TargetLock(path, holder);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw wrapIoError(error, path, "write");
      }

      if (now() >= deadline) {
        const inspection = await inspectLock(path, now);
        throw new ConfigKitError({
          code: "LOCK_TIMEOUT",
          message: `Timed out waiting for the target lock at ${path}`,
          phase: "lock",
          path,
          retryable: true,
          details: {
            holder: inspection.holder ?? null,
            corrupt: inspection.corrupt ?? false,
          },
        });
      }
      await delay(40 + Math.floor(Math.random() * 40));
    }
  }

  async release(): Promise<void> {
    const current = await readLockHolder(this.path);
    if (current === null) return;
    if (current.transactionId !== this.holder.transactionId) {
      // Someone else owns the lock now; never remove it blindly.
      return;
    }
    await removeFileIfExists(this.path);
  }
}

export async function inspectLock(
  path: string,
  now: () => number = Date.now,
): Promise<LockInspection> {
  let raw: string;
  let mtimeMs: number | undefined;
  try {
    raw = await readFile(path, "utf8");
    mtimeMs = (await stat(path)).mtimeMs;
  } catch (error) {
    if (isCode(error, "ENOENT")) return { held: false, path };
    throw wrapIoError(error, path, "read");
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    if (
      typeof parsed.transactionId !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      throw new Error("invalid lock holder");
    }
    const startedAt = Date.parse(parsed.startedAt);
    const ageMs = Number.isFinite(startedAt)
      ? Math.max(0, now() - startedAt)
      : mtimeMs === undefined
        ? 0
        : Math.max(0, now() - mtimeMs);
    return {
      held: true,
      path,
      holder: {
        transactionId: parsed.transactionId,
        pid: parsed.pid,
        hostname: parsed.hostname,
        startedAt: parsed.startedAt,
        ageMs,
      },
    };
  } catch {
    return { held: true, corrupt: true, path };
  }
}

/**
 * Remove a stale lock only on explicit request.
 *
 * A lock is considered stale when it is older than `staleMs` and its owner is
 * either on another host or no longer running. This function is never called
 * automatically by `apply()`.
 */
export async function breakStaleLock(
  path: string,
  options: BreakStaleLockOptions = {},
): Promise<LockInspection> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const now = options.now ?? Date.now;
  const inspection = await inspectLock(path, now);
  if (!inspection.held) return inspection;

  const ageMs =
    inspection.holder?.ageMs ??
    (await fileAgeMs(path, now).catch(() => 0));
  if (ageMs < staleMs) {
    throw new ConfigKitError({
      code: "LOCK_TIMEOUT",
      message: `Lock at ${path} is not stale yet (${Math.round(ageMs / 1000)}s old)`,
      phase: "recover",
      path,
      retryable: true,
    });
  }

  if (inspection.holder) {
    const sameHost = inspection.holder.hostname === osHostname();
    if (sameHost && isProcessAlive(inspection.holder.pid)) {
      throw new ConfigKitError({
        code: "LOCK_TIMEOUT",
        message: `Lock holder process ${inspection.holder.pid} is still running`,
        phase: "recover",
        path,
        retryable: true,
      });
    }
  }

  await removeFileIfExists(path);
  return inspection;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}

async function readLockHolder(path: string): Promise<LockHolder | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as LockHolder;
    if (typeof parsed.transactionId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function fileAgeMs(path: string, now: () => number): Promise<number> {
  const stats = await stat(path);
  return Math.max(0, now() - stats.mtimeMs);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}