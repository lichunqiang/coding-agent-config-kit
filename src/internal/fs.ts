import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { ConfigKitError } from "../errors.js";
import { sha256 } from "./hash.js";

export interface FileFingerprint {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  mode?: number;
  sha256?: string;
}

export interface AtomicWriteOptions {
  mode?: number;
  fsyncDir?: boolean;
}

export async function readFileIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

export async function fingerprintFile(path: string): Promise<FileFingerprint> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isCode(error, "ENOENT")) return { exists: false };
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new ConfigKitError({
      code: "UNSAFE_TARGET",
      message: `Refusing to operate on a symbolic link: ${path}`,
      phase: "read",
      path,
    });
  }
  if (!stats.isFile()) {
    throw new ConfigKitError({
      code: "UNSAFE_TARGET",
      message: `Target is not a regular file: ${path}`,
      phase: "read",
      path,
    });
  }
  const bytes = await readFile(path);
  return {
    exists: true,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode & 0o777,
    sha256: sha256(bytes),
  };
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      throw new ConfigKitError({
        code: "UNSAFE_TARGET",
        message: `Expected a directory at ${path}`,
        phase: "write",
        path,
      });
    }
    if ((stats.mode & 0o077) !== 0) {
      await chmod(path, 0o700);
    }
  } catch (error) {
    if (error instanceof ConfigKitError) throw error;
    throw wrapIoError(error, path, "write");
  }
}

/**
 * Write a file through a same-directory temporary file.
 *
 * The temporary file is created exclusively with the final permissions, synced,
 * and then renamed over the destination. On Linux/macOS the parent directory is
 * synced as well; Windows does not support directory handles.
 */
export async function atomicWriteFile(
  path: string,
  data: Uint8Array | string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const dir = dirname(path);
  const mode = options.mode ?? 0o600;
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    if (options.fsyncDir !== false) await fsyncDirectory(dir);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    if (error instanceof ConfigKitError) throw error;
    throw wrapIoError(error, path, "write");
  }
}

export async function removeFileIfExists(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw wrapIoError(error, path, "write");
  }
}

async function fsyncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (error) {
    if (!isIgnorableFsyncError(error)) throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function isIgnorableFsyncError(error: unknown): boolean {
  return (
    isCode(error, "EINVAL") ||
    isCode(error, "EISDIR") ||
    isCode(error, "EPERM") ||
    isCode(error, "EBADF") ||
    isCode(error, "ENOTSUP")
  );
}

export function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export function wrapIoError(
  error: unknown,
  path: string,
  phase: "read" | "write",
): ConfigKitError {
  if (error instanceof ConfigKitError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new ConfigKitError({
    code: "UNSAFE_TARGET",
    message: `Unable to ${phase} ${path}: ${reason}`,
    phase,
    path,
    cause: error,
  });
}