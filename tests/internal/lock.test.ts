import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TargetLock,
  breakStaleLock,
  inspectLock,
  isProcessAlive,
} from "../../src/internal/lock.js";

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "config-kit-lock-"));
  lockPath = join(dir, "lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TargetLock", () => {
  it("acquires and releases a lock", async () => {
    const lock = await TargetLock.acquire(lockPath);
    const inspection = await inspectLock(lockPath);
    expect(inspection.held).toBe(true);
    expect(inspection.holder?.transactionId).toBe(lock.holder.transactionId);
    expect(inspection.holder?.pid).toBe(process.pid);

    await lock.release();
    expect(await inspectLock(lockPath)).toMatchObject({ held: false });
  });

  it("times out while another holder is active and reports it", async () => {
    const held = await TargetLock.acquire(lockPath);
    await expect(
      TargetLock.acquire(lockPath, { timeoutMs: 120 }),
    ).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
      retryable: true,
    });
    const inspection = await inspectLock(lockPath);
    expect(inspection.holder?.transactionId).toBe(held.holder.transactionId);
    await held.release();
  });

  it("waits for a holder that releases within the timeout", async () => {
    const held = await TargetLock.acquire(lockPath);
    const waiting = TargetLock.acquire(lockPath, { timeoutMs: 2_000 });
    setTimeout(() => {
      void held.release();
    }, 80);
    const acquired = await waiting;
    expect(acquired.holder.transactionId).not.toBe(held.holder.transactionId);
    await acquired.release();
  });
});

describe("breakStaleLock", () => {
  it("does not break a fresh lock", async () => {
    await TargetLock.acquire(lockPath);
    await expect(breakStaleLock(lockPath, { staleMs: 60_000 })).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
    });
  });

  it("breaks a stale lock from a dead process", async () => {
    const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    await writeFile(
      lockPath,
      JSON.stringify({
        transactionId: "stale",
        pid: 999_999_999,
        hostname: "other-host",
        startedAt,
      }),
      "utf8",
    );
    expect(isProcessAlive(999_999_999)).toBe(false);
    const broken = await breakStaleLock(lockPath, { staleMs: 1_000 });
    expect(broken.held).toBe(true);
    expect((await inspectLock(lockPath)).held).toBe(false);
  });

  it("refuses to break a stale-looking lock whose same-host process is alive", async () => {
    const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    await writeFile(
      lockPath,
      JSON.stringify({
        transactionId: "alive",
        pid: process.pid,
        hostname: hostname(),
        startedAt,
      }),
      "utf8",
    );
    await expect(breakStaleLock(lockPath, { staleMs: 1_000 })).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
    });
  });

  it("reports a corrupt lock instead of guessing", async () => {
    await writeFile(lockPath, "not json", "utf8");
    const inspection = await inspectLock(lockPath);
    expect(inspection).toMatchObject({ held: true, corrupt: true });
    await expect(breakStaleLock(lockPath, { staleMs: 60_000 })).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
    });
  });
});
