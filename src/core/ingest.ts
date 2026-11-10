/**
 * `ingest` — bring a raw emulator capture into the store as a Recording.
 *
 * A Recording lives at `recordings/<recording-id>/` with its raw file and its cut
 * list (format-spec §1-2). Ingest copies the source in, reads the frame count and
 * per-frame delays from its metadata, captures a content hash, and writes
 * `cuts.json` with an empty cut list. The `recording-id` is **caller-assigned**:
 * `sharp` metadata carries no filename, so it can never be recovered from the file
 * (docs/recordings.md).
 *
 * Per-frame delays are returned as an array and are **never** collapsed to a
 * uniform frame rate. They are not persisted in `cuts.json` (format-spec §2 Rule
 * 2.2): a Clip re-reads them from the source at generation time.
 */

import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { StoreError } from './errors.js';
import { isValidId } from './ids.js';
import { cutsPath, recordingDir, sourcePath } from './layout.js';
import type { CutList } from './segments.js';
import {
  pathExists,
  readBinaryFile,
  readExternalFile,
  readJsonFile,
  writeBinaryFile,
  writeJsonFile,
} from './store/index.js';
import type { RelPath } from './store/index.js';

/** Inputs for {@link ingestRecording}. */
export interface IngestRecordingOptions {
  /** Filesystem path to the raw capture. May be absolute or relative to the process. */
  sourcePath: string;
  /** Caller-assigned id; validated against the id grammar. Never read from the file. */
  recordingId: string;
}

/** The Recording as registered by {@link ingestRecording}. */
export interface IngestedRecording {
  /** The recording id (its folder name). */
  id: string;
  /** Store-relative POSIX directory. */
  dir: string;
  /** `sha256:` + 64 lowercase hex of the source bytes. */
  hash: string;
  /** Frame count read from the source. */
  frameCount: number;
  /** Per-frame delays in ms, read from the source; never collapsed. */
  delaysMs: number[];
}

/**
 * Register a raw capture as a Recording under the caller-assigned id.
 *
 * Idempotent for an unchanged source; a source that no longer matches the recorded
 * hash or frame count is a hard error, never a silent overwrite.
 */
export async function ingestRecording(
  root: string,
  options: IngestRecordingOptions,
): Promise<IngestedRecording> {
  const { recordingId, sourcePath: sourceFile } = options;

  // The id is caller-assigned and becomes the folder name, so it must satisfy the
  // id grammar before anything touches the store.
  if (!isValidId(recordingId)) {
    throw new StoreError(
      `Invalid recording id "${recordingId}": must match /^[a-z][a-z0-9-]*$/.`,
    );
  }

  const bytes = await readBytes(sourceFile);
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const { frameCount, delaysMs } = await readSourceFacts(bytes, sourceFile);

  const cutListPath = cutsPath(recordingId);

  if (await pathExists(root, cutListPath)) {
    // A Recording under this id already exists: the incoming source must match
    // what is on record, or the store and the source disagree.
    const recorded = await readJsonFile(root, cutListPath);
    if (!matchesRecordedSource(recorded, hash, frameCount)) {
      throw new StoreError(
        `Ingest mismatch for recording "${recordingId}": the file no longer ` +
          `matches the recorded hash/frame count. Recorded ` +
          `${describeRecorded(recorded)}; file is ${describeFile(hash, frameCount)}.`,
      );
    }
    await ensureSourcePresent(root, sourcePath(recordingId), bytes);
    return { id: recordingId, dir: recordingDir(recordingId), hash, frameCount, delaysMs };
  }

  await writeBinaryFile(root, sourcePath(recordingId), bytes);
  const cutList: CutList = { hash, frameCount, cuts: [] };
  await writeJsonFile(root, cutListPath, cutList);

  return { id: recordingId, dir: recordingDir(recordingId), hash, frameCount, delaysMs };
}

/** Read the source, turning a missing/unreadable file into a clear store error. */
async function readBytes(sourceFile: string): Promise<Buffer> {
  try {
    return await readExternalFile(sourceFile);
  } catch (error) {
    throw new StoreError(`Cannot read recording file "${sourceFile}": ${(error as Error).message}`);
  }
}

/** Frame count and per-frame delays, straight from one animated metadata read. */
async function readSourceFacts(
  bytes: Buffer,
  sourceFile: string,
): Promise<{ frameCount: number; delaysMs: number[] }> {
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { animated: true }).metadata();
  } catch (error) {
    throw new StoreError(`Cannot decode recording file "${sourceFile}": ${(error as Error).message}`);
  }

  const frameCount = metadata.pages;
  const delaysMs = metadata.delay;
  if (typeof frameCount !== 'number' || frameCount < 1) {
    throw new StoreError(`Recording file "${sourceFile}" reports no frames.`);
  }
  if (!Array.isArray(delaysMs) || delaysMs.length !== frameCount) {
    throw new StoreError(
      `Recording file "${sourceFile}" does not report per-frame delays ` +
        `(expected ${frameCount}, got ${Array.isArray(delaysMs) ? delaysMs.length : 'none'}).`,
    );
  }

  return { frameCount, delaysMs: [...delaysMs] };
}

/** Copy the source in only if it is not already there (idempotent re-ingest). */
async function ensureSourcePresent(root: string, relPath: RelPath, bytes: Buffer): Promise<void> {
  if (!(await pathExists(root, relPath))) {
    await writeBinaryFile(root, relPath, bytes);
  }
}

function matchesRecordedSource(recorded: unknown, hash: string, frameCount: number): boolean {
  return (
    isRecord(recorded) && recorded.hash === hash && recorded.frameCount === frameCount
  );
}

function describeRecorded(recorded: unknown): string {
  if (isRecord(recorded)) {
    return `{ hash: ${String(recorded.hash)}, frameCount: ${String(recorded.frameCount)} }`;
  }
  return 'an unreadable cut list';
}

function describeFile(hash: string, frameCount: number): string {
  return `{ hash: ${hash}, frameCount: ${frameCount} }`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A single Recording frame, encoded as PNG for the browser preview. */
export interface RecordingFrame {
  /** Store-relative POSIX path of the source the frame came from. */
  path: string;
  /** Always `image/png`. */
  contentType: 'image/png';
  /** The encoded PNG bytes. */
  data: Buffer;
}

/**
 * Read one frame of a Recording as PNG.
 *
 * The filmstrip is a scrubber, so picking a frame has to show something; the
 * source is an animated file and the browser cannot slice it. The frame is
 * composited over the opaque background the GIF itself carries, so what is
 * shown is what the capture looked like.
 */
export async function readRecordingFrame(
  root: string,
  options: { recordingId: string; index: number },
): Promise<RecordingFrame> {
  const { recordingId, index } = options;
  if (!isValidId(recordingId)) {
    throw new StoreError(
      `Invalid recording id "${recordingId}": must match /^[a-z][a-z0-9-]*$/.`,
    );
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new StoreError(`Recording frame index must be an integer >= 0; got ${index}.`);
  }

  const relPath = sourcePath(recordingId);
  if (!(await pathExists(root, relPath))) {
    throw new StoreError(
      `Recording "${recordingId}" has no recording file (${relPath} is missing).`,
    );
  }
  const bytes = await readBinaryFile(root, relPath);

  let pages: number | undefined;
  try {
    pages = (await sharp(bytes, { animated: true }).metadata()).pages;
  } catch (error) {
    throw new StoreError(
      `Cannot decode recording file for "${recordingId}": ${(error as Error).message}`,
    );
  }
  const frameCount = pages ?? 1;
  if (index >= frameCount) {
    throw new StoreError(
      `Recording "${recordingId}" has ${frameCount} frame(s); frame ${index} is out of range.`,
    );
  }

  const data = await sharp(bytes, { animated: true, page: index, pages: 1 })
    .flatten({ background: '#000000' })
    .png()
    .toBuffer();
  return { path: relPath, contentType: 'image/png', data };
}
