/**
 * The single filesystem boundary.
 *
 * Every read or write of the store — and the tool's own schema files — goes
 * through this module. Nothing else in `core` imports `node:fs`, so the rest of
 * core can be reasoned about as pure operations over in-memory data.
 *
 * All paths handed to these helpers are **relative to the store root** and use
 * POSIX separators (the store convention). They are resolved against the root and
 * can never escape it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StoreError } from '../errors.js';

/** A path relative to the store root. POSIX separators; `.` / `''` is the root. */
export type RelPath = string;

/** Resolve a store-relative path to an absolute one, refusing to escape the root. */
export function resolveInStore(root: string, relPath: RelPath): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, relPath);
  const relative = path.relative(rootAbs, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StoreError(`Path escapes the store root: ${relPath}`);
  }
  return abs;
}

/** Does anything exist at `relPath`? */
export async function pathExists(root: string, relPath: RelPath): Promise<boolean> {
  try {
    await fs.stat(resolveInStore(root, relPath));
    return true;
  } catch {
    return false;
  }
}

/** Is `relPath` an existing directory? */
export async function isDirectory(root: string, relPath: RelPath): Promise<boolean> {
  try {
    return (await fs.stat(resolveInStore(root, relPath))).isDirectory();
  } catch {
    return false;
  }
}

/** Names of the immediate sub-directories of `relPath`, sorted. Missing folder -> `[]`. */
export async function listDirectories(root: string, relPath: RelPath): Promise<string[]> {
  return listEntries(root, relPath, (entry) => entry.isDirectory());
}

/** Names of the immediate files of `relPath`, sorted. Missing folder -> `[]`. */
export async function listFiles(root: string, relPath: RelPath): Promise<string[]> {
  return listEntries(root, relPath, (entry) => entry.isFile());
}

async function listEntries(
  root: string,
  relPath: RelPath,
  keep: (entry: { isDirectory(): boolean; isFile(): boolean }) => boolean,
): Promise<string[]> {
  try {
    const entries = await fs.readdir(resolveInStore(root, relPath), { withFileTypes: true });
    return entries
      .filter(keep)
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
}

/** Read and JSON-parse a store artifact. */
export async function readJsonFile(root: string, relPath: RelPath): Promise<unknown> {
  const text = await readTextFile(root, relPath);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StoreError(`Malformed JSON at ${relPath}: ${(error as Error).message}`);
  }
}

/** Read a file as UTF-8 text. */
export async function readTextFile(root: string, relPath: RelPath): Promise<string> {
  return fs.readFile(resolveInStore(root, relPath), 'utf8');
}

/** Read a file as bytes. */
export async function readBinaryFile(root: string, relPath: RelPath): Promise<Buffer> {
  return fs.readFile(resolveInStore(root, relPath));
}

/** Write a JSON artifact (pretty-printed), creating parent directories. */
export async function writeJsonFile(root: string, relPath: RelPath, value: unknown): Promise<void> {
  await writeBinaryFile(root, relPath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

/**
 * Write bytes to a file, creating parent directories.
 *
 * The write goes to a sibling temp file and is then renamed over the target. A
 * plain `writeFile` is not atomic: a concurrent reader can catch the half-written
 * file, which is exactly how a `draft.json` mid-edit used to fail as "Malformed
 * JSON ... Unexpected end of JSON input".
 */
export async function writeBinaryFile(root: string, relPath: RelPath, data: Uint8Array): Promise<void> {
  const abs = resolveInStore(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Same directory, so the rename stays on one filesystem and cannot EXDEV.
  const temp = `${abs}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, abs);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/**
 * Run `body` with no other queued mutation on this store in flight.
 *
 * Atomic writes stop a reader seeing half a file, but two read-modify-writes can
 * still interleave (edit X, edit Y: both read, both write, one edit is lost).
 * Front ends queue their mutating calls through here. Writes only, and short —
 * this is a single-user local tool, so a simple FIFO per root is enough.
 */
export function withStoreLock<T>(root: string, body: () => Promise<T>): Promise<T> {
  const previous = storeLocks.get(root) ?? Promise.resolve();
  const run = previous.then(body, body);
  // Keep the chain alive after a rejection, and drop it once nothing is queued.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  storeLocks.set(root, settled);
  void settled.then(() => {
    if (storeLocks.get(root) === settled) {
      storeLocks.delete(root);
    }
  });
  return run;
}

const storeLocks = new Map<string, Promise<void>>();

/**
 * Read a file that lives **outside** the store — the one deliberate external
 * read. Ingest takes a raw capture from an arbitrary path, hashes it and copies
 * it in; the path is used as given and is not confined to the store root. Every
 * other read/write here is store-relative.
 */
export async function readExternalFile(absPath: string): Promise<Buffer> {
  return fs.readFile(absPath);
}

/** Create a directory (and parents). */
export async function ensureDirectory(root: string, relPath: RelPath): Promise<void> {
  await fs.mkdir(resolveInStore(root, relPath), { recursive: true });
}

/** Remove a file or directory (recursively). Missing paths are ignored. */
export async function removePath(root: string, relPath: RelPath): Promise<void> {
  await fs.rm(resolveInStore(root, relPath), { recursive: true, force: true });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: string }).code === 'ENOENT' || (error as { code?: string }).code === 'ENOTDIR')
  );
}
