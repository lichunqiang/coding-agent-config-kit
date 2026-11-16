import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ConfigKitError } from "../errors.js";
import type { AgentId } from "../types.js";
import { atomicWriteFile, ensurePrivateDir, isCode } from "./fs.js";

export type ManagedEntryKind = "provider" | "model" | "default-model" | "field";

export interface ManagedEntry {
  kind: ManagedEntryKind;
  /** Field paths owned by this SDK, e.g. ["baseUrl", "apiKey"]. */
  fields: string[];
  /** Non-sensitive last-managed values used for conflict detection. */
  baseline?: Record<string, unknown>;
  updatedAt?: string;
}

export interface ManagementRecord {
  schemaVersion: 1;
  ownerId: string;
  agent: AgentId;
  configDir: string;
  updatedAt: string;
  entries: Record<string, ManagedEntry>;
}

export function emptyManagementRecord(
  ownerId: string,
  agent: AgentId,
  configDir: string,
  now: Date = new Date(),
): ManagementRecord {
  return {
    schemaVersion: 1,
    ownerId,
    agent,
    configDir,
    updatedAt: now.toISOString(),
    entries: {},
  };
}

export async function readManagement(path: string): Promise<ManagementRecord | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw new ConfigKitError({
      code: "UNPARSEABLE_CONFIG",
      message: `Unable to read management record at ${path}`,
      phase: "read",
      path,
      cause: error,
    });
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ManagementRecord>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.ownerId !== "string" ||
      typeof parsed.agent !== "string" ||
      typeof parsed.entries !== "object" ||
      parsed.entries === null
    ) {
      throw new Error("invalid management record");
    }
    return parsed as ManagementRecord;
  } catch (error) {
    throw new ConfigKitError({
      code: "UNPARSEABLE_CONFIG",
      message: `Management record at ${path} is not valid`,
      phase: "read",
      path,
      cause: error,
    });
  }
}

export async function writeManagement(path: string, record: ManagementRecord): Promise<void> {
  await ensurePrivateDir(dirname(path));
  await atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}
