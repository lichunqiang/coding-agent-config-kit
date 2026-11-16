import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isJournalExpired,
  journalAgeMs,
  readJournal,
  readJournalIfExists,
  removeJournal,
  updateJournalStatus,
  writeJournal,
  type RecoveryRecord,
} from "../../src/internal/journal.js";

let dir: string;
let journalPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "config-kit-journal-"));
  journalPath = join(dir, ".coding-agent-config-kit", "recovery.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function record(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    schemaVersion: 1,
    transactionId: "tx-1",
    ownerId: "owner",
    agent: "pi",
    configDir: dir,
    status: "prepared",
    createdAt: new Date().toISOString(),
    files: [
      {
        path: join(dir, "models.json"),
        before: { exists: true, sha256: "old", contentBase64: Buffer.from("old").toString("base64") },
        after: { exists: true, sha256: "new" },
      },
    ],
    ...overrides,
  };
}

describe("recovery journal", () => {
  it("writes and reads a record with private permissions", async () => {
    await writeJournal(journalPath, record());
    const loaded = await readJournal(journalPath);
    expect(loaded.transactionId).toBe("tx-1");
    expect(loaded.files).toHaveLength(1);

    if (process.platform !== "win32") {
      expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("updates status in place", async () => {
    await writeJournal(journalPath, record());
    const updated = await updateJournalStatus(journalPath, "committing");
    expect(updated.status).toBe("committing");
    expect((await readJournal(journalPath)).status).toBe("committing");
  });

  it("reads a missing journal as null through the optional helper", async () => {
    expect(await readJournalIfExists(journalPath)).toBeNull();
    await expect(readJournal(journalPath)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  });

  it("removes the journal", async () => {
    await writeJournal(journalPath, record());
    await removeJournal(journalPath);
    expect(await readJournalIfExists(journalPath)).toBeNull();
  });

  it("computes age and expiry", () => {
    const old = record({ createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });
    expect(journalAgeMs(old)).toBeGreaterThan(60 * 60_000);
    expect(isJournalExpired(old, 60 * 60_000)).toBe(true);
    expect(isJournalExpired(record(), 60 * 60_000)).toBe(false);
  });

  it("rejects malformed records", async () => {
    await mkdir(join(dir, ".coding-agent-config-kit"), { recursive: true });
    await writeFile(journalPath, "{ not json", "utf8");
    await expect(readJournal(journalPath)).rejects.toMatchObject({
      code: "UNPARSEABLE_CONFIG",
    });
  });

  it("keeps the old content needed for recovery", async () => {
    await writeJournal(journalPath, record());
    const raw = JSON.parse(await readFile(journalPath, "utf8")) as RecoveryRecord;
    expect(Buffer.from(raw.files[0]!.before.contentBase64!, "base64").toString()).toBe("old");
  });
});