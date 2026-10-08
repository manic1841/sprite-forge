/**
 * `draft` — extract a Segment into a Clip **Draft**.
 *
 * A **Draft** is editable, not-yet-committed working state (GLOSSARY.md). It lives
 * under `characters/<character-id>/drafts/<draft-id>/`, so it survives a reload
 * and both front ends resume from it (docs/architecture.md). Its on-disk shape is
 * **not** a frozen format (format-spec §11): this module designs it.
 *
 * Extracting a Segment runs stages 2-4 of the pipeline for one frame range:
 *
 *   1. **Extract** — decode the Segment's frames from the Recording's `source.gif`.
 *   2. **De-background** — colour-key the corner-sampled backdrop to binary alpha.
 *   3. **Crop + align** — crop to the union of content bounds, then place the
 *      frames on the Character's shared Canvas via the Anchor.
 *
 * The Draft carries the per-frame delays and a `loop` flag, and records the
 * background `{hex, source, tolerance}` so the de-background step is reproducible.
 * A Clip **never** stores its own frame size: the frame size is always the
 * Character's Canvas (Rule 3.2), so the descriptor carries no width or height.
 */

import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import {
  sampleBackgroundColor,
  keyBackground,
  parseHexColor,
  toHexColor,
  DEFAULT_TOLERANCE,
  type Rgb,
  type RgbaImage,
} from './background.js';
import type { Canvas } from './character.js';
import { StoreError, ValidationError, type ValidationIssue } from './errors.js';
import { contentBounds, cropTo, placeOnCanvas, unionBounds, type Bounds } from './frames.js';
import { isValidId } from './ids.js';
import {
  canvasPath,
  draftDir,
  draftFramePath,
  draftPath,
  sourcePath,
} from './layout.js';
import { readCutList } from './segments.js';
import type { AssetRef } from './types.js';
import {
  pathExists,
  readBinaryFile,
  readJsonFile,
  removePath,
  writeBinaryFile,
  writeJsonFile,
} from './store/index.js';
import { validateArtifact } from './validate.js';
import { SPRITE_FORGE_VERSION } from './version.js';

/** A snapshot of the resolved cut this Draft came from (Rule 6.1). */
export interface DraftSegmentSnapshot {
  /** The Segment's cut id. */
  cutId: string;
  /** Inclusive first frame of the range. */
  startFrame: number;
  /** Exclusive end of the range. */
  endFrame: number;
  /** Playback multiplier; `1` when the Segment carries none. */
  speed: number;
}

/** How the backdrop was chosen, so the de-background step is reproducible. */
export interface DraftBackground {
  /** `#rrggbb`, lowercase. */
  hex: string;
  /** `sampled` from a corner, or an explicit `override`. */
  source: 'sampled' | 'override';
  /** Per-channel key tolerance used. */
  tolerance: number;
}

/** The Draft descriptor as persisted at `.../drafts/<draft-id>/draft.json`. */
export interface ClipDraftDescriptor {
  /** The Draft id (its folder name). */
  id: string;
  /** The owning Character. */
  characterId: string;
  /** The source Recording. */
  recordingId: string;
  /** `sha256:` + 64 lowercase hex of the source. */
  recordingHash: string;
  /** The resolved cut as it was at extraction time. */
  segment: DraftSegmentSnapshot;
  /** The recorded background key. */
  background: DraftBackground;
  /** Number of frames. */
  frameCount: number;
  /** Per-frame delays in ms, read from the source. */
  delaysMs: number[];
  /** Whether the Clip should loop. */
  loop: boolean;
  /** The tool version that produced the Draft. */
  spriteForgeVersion: string;
  /**
   * The Asset this Draft was forked from, when it came from a fork (format-spec
   * §8). Absent for a Draft extracted straight from a Recording. It is carried
   * into the committed Asset's provenance.
   */
  derivedFrom?: AssetRef | null;
  /**
   * A manual placement offset on top of the automatic Anchor (docs/alignment.md).
   * Absent when `{0,0}`; carried into the committed Asset's provenance and
   * inherited by a fork.
   */
  placementOffset?: { x: number; y: number };
  /**
   * A fork's inherited Repair-script reference (docs/repair.md, format-spec §6).
   * Absent when there is no Repair. Part of the fork seam: Repair scripts land in
   * #27; commit re-homes this reference onto the new Asset's Clip id.
   */
  repair?: string | null;
}

/** A read-back Clip Draft: its descriptor plus the paths of its frame PNGs. */
export interface ClipDraft extends ClipDraftDescriptor {
  /** Store-relative POSIX directory. */
  dir: string;
  /** Store-relative POSIX paths of the frame PNGs, in frame order. */
  frames: string[];
}

/** Inputs for {@link extractClipDraft}. */
export interface ExtractClipDraftOptions {
  /** The Character whose Canvas/Anchor the Draft adopts. */
  characterId: string;
  /** The Recording the Segment was cut from. */
  recordingId: string;
  /** The cut id of the Segment to extract. */
  cutId: string;
  /** The Draft id; defaults to the cut id. */
  draftId?: string;
  /** An explicit `#rrggbb` background override; sampled from a corner when omitted. */
  background?: string;
  /** Per-channel key tolerance; defaults to 24. */
  tolerance?: number;
  /** Whether the Draft loops; defaults to `true`. */
  loop?: boolean;
}

/** Inputs for {@link readClipDraft}. */
export interface ReadClipDraftOptions {
  /** The Character that owns the Draft. */
  characterId: string;
  /** The Draft id. */
  draftId: string;
}

/**
 * Extract a Segment from a Recording into a new Clip Draft for a Character.
 *
 * Everything is validated before it is written: a bad Canvas, a missing Segment,
 * a swapped source, or content that does not fit the Canvas is a hard error and
 * leaves no Draft behind. Re-extracting the same Draft id refreshes it.
 */
export async function extractClipDraft(
  root: string,
  options: ExtractClipDraftOptions,
): Promise<ClipDraft> {
  const { characterId, recordingId, cutId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(recordingId, 'recording', 'recordingId');
  assertValidId(cutId, 'cut', 'cutId');
  const draftId = options.draftId ?? cutId;
  assertValidId(draftId, 'draft', 'draftId');

  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) {
    throw new StoreError(`Tolerance must be an integer in 0..255; got ${tolerance}.`);
  }

  const canvas = await readCanvas(root, characterId);
  const cut = await resolveSegment(root, recordingId, cutId);
  const bytes = await readSource(root, recordingId, cut.hash);
  const decoded = await decodeSegment(bytes, recordingId, cut);

  const frames = decoded.frames;
  const override = options.background !== undefined;
  const background: Rgb = override
    ? parseHexColor(options.background!)
    : sampleBackgroundColor(frames);
  const backgroundRecord: DraftBackground = {
    hex: toHexColor(background),
    source: override ? 'override' : 'sampled',
    tolerance,
  };

  // De-background every frame to binary alpha (research §2-3).
  const keyed = frames.map((frame) => keyBackground(frame, background, tolerance));

  // Crop to the union of content bounds; place by the FIRST frame's foot base.
  const perFrame = keyed.map((frame) => contentBounds(frame));
  const first = perFrame[0] ?? null;
  if (first === null) {
    throw new StoreError(
      `Segment "${cutId}" has no content to extract (every frame is the background colour).`,
    );
  }
  const union = unionBounds(perFrame.filter((box): box is Bounds => box !== null));
  const { dx, dy } = automaticPlacement(first, union, canvas);

  await removePath(root, draftDir(characterId, draftId));

  const framePaths: string[] = [];
  for (let index = 0; index < keyed.length; index++) {
    const placed = placeOnCanvas(
      cropTo(keyed[index]!, union),
      canvas.width,
      canvas.height,
      dx,
      dy,
    );
    const png = await sharp(Buffer.from(placed.data), {
      raw: { width: placed.width, height: placed.height, channels: 4 },
    })
      .png()
      .toBuffer();
    const relPath = draftFramePath(characterId, draftId, index);
    await writeBinaryFile(root, relPath, png);
    framePaths.push(relPath);
  }

  const descriptor: ClipDraftDescriptor = {
    id: draftId,
    characterId,
    recordingId,
    recordingHash: cut.hash,
    segment: {
      cutId,
      startFrame: cut.startFrame,
      endFrame: cut.endFrame,
      speed: cut.speed ?? 1,
    },
    background: backgroundRecord,
    frameCount: keyed.length,
    delaysMs: decoded.delaysMs.slice(cut.startFrame, cut.endFrame),
    loop: options.loop ?? true,
    spriteForgeVersion: SPRITE_FORGE_VERSION,
  };

  validateDraftDescriptor(descriptor, draftPath(characterId, draftId), draftId);
  await writeClipDraft(root, descriptor);

  return { ...descriptor, dir: draftDir(characterId, draftId), frames: framePaths };
}

/**
 * Validate a Draft descriptor and persist it at `.../drafts/<draft-id>/draft.json`.
 *
 * A malformed Draft is a hard error, never warn-and-continue. Shared by
 * `extractClipDraft` and the fork path so both write the same validated shape.
 */
export async function writeClipDraft(root: string, descriptor: ClipDraftDescriptor): Promise<void> {
  const artifactPath = draftPath(descriptor.characterId, descriptor.id);
  validateDraftDescriptor(descriptor, artifactPath, descriptor.id);
  await writeJsonFile(root, artifactPath, descriptor);
}

/** Read a Draft back from the store — the reload path both front ends resume from. */
export async function readClipDraft(
  root: string,
  options: ReadClipDraftOptions,
): Promise<ClipDraft> {
  const { characterId, draftId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(draftId, 'draft', 'draftId');

  const descriptorPath = draftPath(characterId, draftId);
  if (!(await pathExists(root, descriptorPath))) {
    throw new StoreError(
      `No Draft "${draftId}" for Character "${characterId}" (${descriptorPath} is missing).`,
    );
  }

  const value = await readJsonFile(root, descriptorPath);
  validateDraftDescriptor(value, descriptorPath, draftId);
  const descriptor = value as ClipDraftDescriptor;

  const framePaths: string[] = [];
  for (let index = 0; index < descriptor.frameCount; index++) {
    const relPath = draftFramePath(characterId, draftId, index);
    if (!(await pathExists(root, relPath))) {
      throw new StoreError(`Draft "${draftId}" is missing frame ${index} (${relPath}).`);
    }
    framePaths.push(relPath);
  }

  return { ...descriptor, dir: draftDir(characterId, draftId), frames: framePaths };
}

/** Inputs for {@link readClipDraftFrame}. */
export interface ReadClipDraftFrameOptions {
  /** The Character that owns the Draft. */
  characterId: string;
  /** The Draft id. */
  draftId: string;
  /** Zero-based frame index within the Draft. */
  index: number;
}

/** One Draft frame, read as image bytes for a front end to display. */
export interface ClipDraftFrame {
  /** Store-relative POSIX path of the frame PNG. */
  path: string;
  /** The image media type the bytes carry. */
  contentType: 'image/png';
  /** The PNG bytes. */
  data: Buffer;
}

/**
 * Read a single Draft frame as image bytes.
 *
 * The Clip editor shows a Draft frame-by-frame, but a browser cannot read the
 * store; a front end serves these bytes over its own boundary. The descriptor is
 * read and validated first, so an out-of-range or missing frame is a hard error.
 */
export async function readClipDraftFrame(
  root: string,
  options: ReadClipDraftFrameOptions,
): Promise<ClipDraftFrame> {
  const { characterId, draftId, index } = options;
  if (!Number.isInteger(index) || index < 0) {
    throw new StoreError(`Draft frame index must be an integer >= 0; got ${index}.`);
  }
  const draft = await readClipDraft(root, { characterId, draftId });
  if (index >= draft.frameCount) {
    throw new StoreError(
      `Draft "${draftId}" has ${draft.frameCount} frame(s); frame ${index} is out of range.`,
    );
  }
  const relPath = draft.frames[index]!;
  const data = await readBinaryFile(root, relPath);
  return { path: relPath, contentType: 'image/png', data };
}

// --- internals ----------------------------------------------------------------

/** Read and validate the Character's Canvas; its frame size is the Draft's too. */
async function readCanvas(root: string, characterId: string): Promise<Canvas> {
  const artifactPath = canvasPath(characterId);
  if (!(await pathExists(root, artifactPath))) {
    throw new StoreError(
      `No Character "${characterId}" in the store (${artifactPath} is missing).`,
    );
  }
  const value = await readJsonFile(root, artifactPath);
  validateArtifact('canvas', value, { artifact: artifactPath });
  return value as Canvas;
}

/** Resolve the named Segment from the Recording's cut list (already validated on read). */
async function resolveSegment(
  root: string,
  recordingId: string,
  cutId: string,
): Promise<{ startFrame: number; endFrame: number; speed?: number; hash: string }> {
  const cutList = await readCutList(root, recordingId);
  const segment = cutList.cuts.find((cut) => cut.id === cutId);
  if (!segment) {
    throw new StoreError(`No Segment "${cutId}" in Recording "${recordingId}".`);
  }
  return {
    startFrame: segment.startFrame,
    endFrame: segment.endFrame,
    ...(segment.speed !== undefined ? { speed: segment.speed } : {}),
    hash: cutList.hash,
  };
}

/** Read the Recording's source bytes, verifying they still match the recorded hash. */
async function readSource(root: string, recordingId: string, hash: string): Promise<Buffer> {
  const sourceRelPath = sourcePath(recordingId);
  if (!(await pathExists(root, sourceRelPath))) {
    throw new StoreError(
      `Recording "${recordingId}" has no source (${sourceRelPath} is missing).`,
    );
  }
  const bytes = await readBinaryFile(root, sourceRelPath);
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== hash) {
    throw new StoreError(
      `Recording "${recordingId}" source does not match its recorded hash; ` +
        `re-ingest before extracting a Clip.`,
    );
  }
  return bytes;
}

/** Decode one frame range of the source into raw RGBA, with the full delay array. */
async function decodeSegment(
  bytes: Buffer,
  recordingId: string,
  cut: { startFrame: number; endFrame: number },
): Promise<{ frames: RgbaImage[]; delaysMs: number[] }> {
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { animated: true }).metadata();
  } catch (error) {
    throw new StoreError(
      `Cannot decode Recording "${recordingId}" source: ${(error as Error).message}`,
    );
  }

  const pages = metadata.pages;
  const delaysMs = metadata.delay;
  if (typeof pages !== 'number' || !Array.isArray(delaysMs) || delaysMs.length !== pages) {
    throw new StoreError(`Recording "${recordingId}" source does not report usable frames.`);
  }
  if (cut.endFrame > pages) {
    throw new StoreError(
      `Segment ends at frame ${cut.endFrame}, beyond the source's ${pages} frames.`,
    );
  }

  const { data, info } = await sharp(bytes, { animated: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.pageHeight ?? info.height;
  const bytesPerFrame = width * height * 4;

  const frames: RgbaImage[] = [];
  for (let index = cut.startFrame; index < cut.endFrame; index++) {
    const from = index * bytesPerFrame;
    frames.push({
      width,
      height,
      data: new Uint8Array(data.subarray(from, from + bytesPerFrame)),
    });
  }
  return { frames, delaysMs: [...delaysMs] };
}

/**
 * The automatic Anchor placement.
 *
 * The Anchor is the first frame's content-box **bottom-centre** (foot base) and
 * the Canvas is symmetric about it (docs/alignment.md). After cropping to the
 * union box `union`, the first frame's foot base sits at `anchorLocal` within the
 * crop; placing the crop so that point lands on the Canvas Anchor gives `(dx, dy)`.
 * An odd first-frame width puts the centre on a pixel boundary, so we round to the
 * nearest pixel. Content that would spill off the Canvas is a hard error (an
 * explicit expand-canvas action is a later, Character-level operation).
 */
function automaticPlacement(
  first: Bounds,
  union: Bounds,
  canvas: Canvas,
): { dx: number; dy: number } {
  const anchorLocalX = first.x - union.x + first.width / 2;
  const anchorLocalY = first.y - union.y + first.height;
  const dx = Math.round(canvas.anchor.x - anchorLocalX);
  const dy = Math.round(canvas.anchor.y - anchorLocalY);

  if (dx < 0 || dy < 0 || dx + union.width > canvas.width || dy + union.height > canvas.height) {
    throw new StoreError(
      `The Segment's content (${union.width}x${union.height}) does not fit on the ` +
        `Character's Canvas (${canvas.width}x${canvas.height}) at the Anchor; ` +
        `expand the Canvas first.`,
    );
  }
  return { dx, dy };
}

/** Reject an id that does not match the id grammar before it becomes a path segment. */
function assertValidId(id: string, noun: string, label: string): void {
  if (!isValidId(id)) {
    throw new StoreError(`Invalid ${label} "${id}" (${noun} id): must match /^[a-z][a-z0-9-]*$/.`);
  }
}

// --- Draft descriptor validation (design-local; drafts are not a frozen format) --

const DRAFT_KEYS = [
  'id',
  'characterId',
  'recordingId',
  'recordingHash',
  'segment',
  'background',
  'frameCount',
  'delaysMs',
  'loop',
  'spriteForgeVersion',
] as const;

/** Optional Draft fields added by the fork seam (#24); absent on a fresh extract. */
const DRAFT_OPTIONAL_KEYS = ['derivedFrom', 'placementOffset', 'repair'] as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** Validate a Draft descriptor; a malformed Draft is a hard error, never warn-and-continue. */
function validateDraftDescriptor(value: unknown, artifact: string, draftId: string): void {
  const issues: ValidationIssue[] = [];
  const issue = (path: string, message: string): void => {
    issues.push({ artifact, path, message });
  };

  if (!isRecord(value)) {
    throw new ValidationError([{ artifact, path: '', message: 'must be an object' }]);
  }

  const recognised = new Set<string>([...DRAFT_KEYS, ...DRAFT_OPTIONAL_KEYS]);
  for (const key of Object.keys(value)) {
    if (!recognised.has(key)) {
      issue(`/${key}`, 'is not a recognised Draft field');
    }
  }
  for (const key of DRAFT_KEYS) {
    if (!(key in value)) {
      issue(`/${key}`, 'is required');
    }
  }

  if (value.id !== draftId) {
    issue('/id', `must equal the Draft folder name "${draftId}"`);
  }
  for (const key of ['id', 'characterId', 'recordingId'] as const) {
    if (typeof value[key] !== 'string' || !isValidId(value[key] as string)) {
      issue(`/${key}`, 'must match /^[a-z][a-z0-9-]*$/');
    }
  }
  if (typeof value.recordingHash !== 'string' || !SHA256.test(value.recordingHash)) {
    issue('/recordingHash', 'must be "sha256:" + 64 lowercase hex');
  }
  if (typeof value.spriteForgeVersion !== 'string') {
    issue('/spriteForgeVersion', 'must be a string');
  }

  const segment = value.segment;
  if (isRecord(segment)) {
    const { cutId, startFrame, endFrame, speed } = segment;
    if (typeof cutId !== 'string' || !isValidId(cutId)) {
      issue('/segment/cutId', 'must match /^[a-z][a-z0-9-]*$/');
    }
    if (!isInteger(startFrame) || (startFrame as number) < 0) {
      issue('/segment/startFrame', 'must be an integer >= 0');
    }
    if (!isInteger(endFrame) || (endFrame as number) < 1) {
      issue('/segment/endFrame', 'must be an integer >= 1');
    }
    if (isNumber(startFrame) && isNumber(endFrame) && !(endFrame > startFrame)) {
      issue('/segment/endFrame', 'must be greater than startFrame');
    }
    if (!isNumber(speed) || speed <= 0) {
      issue('/segment/speed', 'must be a number > 0');
    }
  } else {
    issue('/segment', 'must be an object');
  }

  const background = value.background;
  if (isRecord(background)) {
    const { hex, source, tolerance } = background;
    if (typeof hex !== 'string' || !HEX_COLOR.test(hex)) {
      issue('/background/hex', 'must be lowercase #rrggbb');
    }
    if (source !== 'sampled' && source !== 'override') {
      issue('/background/source', 'must be "sampled" or "override"');
    }
    if (!isInteger(tolerance) || (tolerance as number) < 0 || (tolerance as number) > 255) {
      issue('/background/tolerance', 'must be an integer in 0..255');
    }
  } else {
    issue('/background', 'must be an object');
  }

  const frameCount = value.frameCount;
  if (!isInteger(frameCount) || (frameCount as number) < 1) {
    issue('/frameCount', 'must be an integer >= 1');
  }
  const delaysMs = value.delaysMs;
  if (!Array.isArray(delaysMs) || delaysMs.length === 0) {
    issue('/delaysMs', 'must be a non-empty array');
  } else {
    delaysMs.forEach((delay, index) => {
      if (!isInteger(delay) || (delay as number) < 1) {
        issue(`/delaysMs/${index}`, 'must be an integer >= 1');
      }
    });
    if (isNumber(frameCount) && delaysMs.length !== 1 && delaysMs.length !== frameCount) {
      issue('/delaysMs', `must have 1 (uniform) or frameCount (${frameCount}) values`);
    }
  }
  if (typeof value.loop !== 'boolean') {
    issue('/loop', 'must be a boolean');
  }

  // Fork-seam fields are optional; when present they must be well-formed.
  if ('derivedFrom' in value && value.derivedFrom !== null && value.derivedFrom !== undefined) {
    const ref = value.derivedFrom;
    if (!isRecord(ref) || (ref.kind !== 'clip' && ref.kind !== 'sequence')) {
      issue('/derivedFrom', 'must be null or an Asset reference {kind, id}');
    } else if (typeof ref.id !== 'string' || !isValidId(ref.id)) {
      issue('/derivedFrom/id', 'must match /^[a-z][a-z0-9-]*$/');
    }
  }
  if ('placementOffset' in value && value.placementOffset !== undefined) {
    const offset = value.placementOffset;
    if (!isRecord(offset) || !isInteger(offset.x) || !isInteger(offset.y)) {
      issue('/placementOffset', 'must be an object with integer x and y');
    } else if (offset.x === 0 && offset.y === 0) {
      issue('/placementOffset', 'must be omitted when {0,0}');
    }
  }
  if ('repair' in value && value.repair !== null && value.repair !== undefined) {
    if (typeof value.repair !== 'string' || value.repair.length === 0) {
      issue('/repair', 'must be null or a store-relative path');
    }
  }

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value);
}
