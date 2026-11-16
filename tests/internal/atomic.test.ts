import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWriteFile, fingerprintFile, readFileIfExists } from "../../src/internal/fs.js";
import { sha256 } from "../../src/internal/hash.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "config-kit-atomic-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
  it("writes the file and leaves no temporary file behind", async () => {
    const path = join(dir, "settings.json");
    await atomicWriteFile(path, "hello\n");

    expect(await readFile(path, "utf8")).toBe("hello\n");
    expect(await readdir(dir)).toEqual(["settings.json"]);

    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("replaces an existing file atomically", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, "old", "utf8");
    await atomicWriteFile(path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
    expect(await readdir(dir)).toEqual(["config.json"]);
  });

  it("honours a broader explicit mode", async () => {
    const path = join(dir, "public.json");
    await atomicWriteFile(path, "{}", { mode: 0o644 });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o644);
    }
  });

  it("readFileIfExists returns null for a missing file", async () => {
    expect(await readFileIfExists(join(dir, "missing.json"))).toBeNull();
  });
});

describe("fingerprintFile", () => {
  it("records size and content hash", async () => {
    const path = join(dir, "state.json");
    await writeFile(path, "abc", "utf8");
    const fingerprint = await fingerprintFile(path);
    expect(fingerprint.exists).toBe(true);
    expect(fingerprint.size).toBe(3);
    expect(fingerprint.sha256).toBe(sha256("abc"));
  });

  it("refuses symbolic links", async () => {
    const target = join(dir, "real.json");
    const link = join(dir, "link.json");
    await writeFile(target, "{}", "utf8");
    const { symlink } = await import("node:fs/promises");
    try {
      await symlink(target, link);
    } catch {
      // Windows without developer mode cannot create symlinks; skip.
      return;
    }
    await expect(fingerprintFile(link)).rejects.toMatchObject({ code: "UNSAFE_TARGET" });
  });
});