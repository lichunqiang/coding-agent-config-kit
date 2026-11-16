import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ConfigKitError } from "../errors.js";
import type { AgentId } from "../types.js";
import { atomicWriteFile, ensurePrivateDir, isCode, removeFileIfExists } from "./fs.js";

export type JournalStatus = "prepared" | "committing" | "committed";

export interface ContentSnapshot {
  exists: boolean;
  sha256?: string;
  mode?: number;
  /** Old content, base64 encoded. Present only when recovery can restore it. */
  contentBase64?: string;
}

export interface JournalFile {
  path: string;
  before: ContentSnapshot;
  after: ContentSnapshot;
}

export interface RecoveryRecord {
  schemaVersion: 1;
  transactionId: string;
  ownerId: string;
  agent: AgentId;
  configDir: string;
  status: JournalStatus;
  createdAt: string;
  files: JournalFile[];
}

export async function writeJournal(path: string, record: RecoveryRecord): Promise<void> {
  await ensurePrivateDir(dirname(path));
  await atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export async function updateJournalStatus(
  path: string,
  status: JournalStatus,
): Promise<RecoveryRecord> {
  const record = await readJournal(path);
  const next: RecoveryRecord = { ...record, status };
  await atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

export async function readJournal(path: string): Promise<RecoveryRecord> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      throw new ConfigKitError({
        code: "RECOVERY_REQUIRED",
        message: "No recovery record exists",
        phase: "recover",
        path,
      });
    }
    throw new ConfigKitError({
      code: "UNPARSEABLE_CONFIG",
      message: `Unable to read recovery record at ${path}`,
      phase: "recover",
      path,
      cause: error,
    });
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RecoveryRecord>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.transactionId !== "string" ||
      typeof parsed.createdAt !== "string" ||
      !Array.isArray(parsed.files)
    ) {
      throw new Error("invalid recovery record");
    }
    return parsed as RecoveryRecord;
  } catch (error) {
    throw new ConfigKitError({
      code: "UNPARSEABLE_CONFIG",
      message: `Recovery record at ${path} is not valid`,
      phase: "recover",
      path,
      cause: error,
    });
  }
}

export async function readJournalIfExists(path: string): Promise<RecoveryRecord | null> {
  try {
    return await readJournal(path);
  } catch (error) {
    if (error instanceof ConfigKitError && error.code === "RECOVERY_REQUIRED") return null;
    throw error;
  }
}

export async function removeJournal(path: string): Promise<void> {
  await removeFileIfExists(path);
}

export function journalAgeMs(record: RecoveryRecord, now: number = Date.now()): number {
  const createdAt = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAt)) return 0;
  return Math.max(0, now - createdAt);
}

export function isJournalExpired(
  record: RecoveryRecord,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  return journalAgeMs(record, now) > ttlMs;
}
