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
import type { Canvas, CanvasAnchor } from './character.js';
import { StoreError, ValidationError, type ValidationIssue } from './errors.js';
import { contentBounds, cropTo, placeOnCanvas, unionBounds, type Bounds } from './frames.js';
import { assertValidId, isValidId } from './ids.js';
import {
  canvasPath,
  draftDir,
  draftFramePath,
  draftPath,
  sourcePath,
} from './layout.js';
import type { RepairFraming } from './repair.js';
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
   * The pixel geometry the Draft's `placementOffset` was authored against,
   * recorded when the offset is set. A later change to the Canvas (an expand) is
   * detected by comparing against it (docs/alignment.md, "Validity").
   * Design-local: Drafts are not a frozen format (format-spec §11).
   */
  placementFraming?: RepairFraming;
  /**
   * A fork's inherited Repair-script reference (docs/repair.md, format-spec §6).
   * Absent when there is no Repair. Part of the fork seam: Repair scripts land in
   * #27; commit re-homes this reference onto the new Asset's Clip id.
   */
  repair?: string | null;
  /**
   * The pixel geometry the Draft's Repair script was authored against, recorded
   * when the first operation is appended (#27). A later change to the frames or
   * Canvas is detected by comparing against it (format-spec Rule 4.3). Design-local:
   * Drafts are not a frozen format (format-spec §11).
   */
  repairFraming?: RepairFraming;
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

  // Read any human state already on this Draft id BEFORE the frames are replaced,
  // so a re-extract keeps pointing at the Repair script and remembers the framing
  // the offset/script were authored against — otherwise a re-cut or re-expand
  // would silently drop the warning (docs/repair.md / docs/alignment.md, "Validity").
  const preserved = await readPreservedDraftState(root, characterId, draftId);

  const rendered = await renderSegmentFrames(root, {
    recordingId,
    segment: { startFrame: cut.startFrame, endFrame: cut.endFrame, speed: cut.speed ?? 1 },
    canvas,
    ...(options.background !== undefined ? { background: options.background } : {}),
    tolerance,
    expectedHash: cut.hash,
  });

  await removePath(root, draftDir(characterId, draftId));

  const framePaths: string[] = [];
  for (let index = 0; index < rendered.frames.length; index++) {
    const placed = rendered.frames[index]!;
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
    background: rendered.background,
    frameCount: rendered.frames.length,
    delaysMs: rendered.delaysMs,
    loop: options.loop ?? true,
    spriteForgeVersion: SPRITE_FORGE_VERSION,
    ...preserved,
  };

  validateDraftDescriptor(descriptor, draftPath(characterId, draftId), draftId);
  await writeClipDraft(root, descriptor);

  return { ...descriptor, dir: draftDir(characterId, draftId), frames: framePaths };
}

/** Inputs for {@link renderSegmentFrames}. */
export interface RenderSegmentFramesOptions {
  /** The Recording the Segment was cut from. */
  recordingId: string;
  /** The half-open frame range to render — a live cut or a provenance snapshot. */
  segment: { startFrame: number; endFrame: number; speed?: number };
  /** The Character's shared Canvas the frames are placed on. */
  canvas: Canvas;
  /** An explicit `#rrggbb` background override; sampled from a corner when omitted. */
  background?: string;
  /** Per-channel key tolerance; defaults to 24. */
  tolerance?: number;
  /** When set, the source bytes must hash to this (`sha256:` + 64 hex) or it is a hard error. */
  expectedHash?: string;
}

/** The result of {@link renderSegmentFrames}: placed frames plus the derived settings. */
export interface RenderedSegment {
  /** One canvas-sized, de-backgrounded, aligned RGBA frame per source frame. */
  frames: RgbaImage[];
  /** Per-frame delays in ms, sliced from the source metadata. */
  delaysMs: number[];
  /** The background key that was used, so de-backgrounding is reproducible. */
  background: DraftBackground;
}

/**
 * Run deterministic pipeline stages 1–4 (extract, de-background, crop, align) for
 * one Segment, from the Recording and settings **alone**.
 *
 * This is the reproducibility seam: given the same Recording (checked against its
 * recorded hash), Segment range and background settings, it yields byte-identical
 * placed frames — whether called by {@link extractClipDraft} or by
 * `verifyReproducible` re-running a committed Asset from its provenance. It is
 * **pure** over the store: it only reads.
 */
export async function renderSegmentFrames(
  root: string,
  options: RenderSegmentFramesOptions,
): Promise<RenderedSegment> {
  const { recordingId, segment, canvas } = options;
  assertValidId(recordingId, 'recording', 'recordingId');
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) {
    throw new StoreError(`Tolerance must be an integer in 0..255; got ${tolerance}.`);
  }
  const speed = segment.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new StoreError(`Segment speed must be a number > 0; got ${speed}.`);
  }

  const bytes = await readSource(root, recordingId, options.expectedHash);
  const decoded = await decodeSegment(bytes, recordingId, segment);

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
      `Segment [${segment.startFrame}, ${segment.endFrame}) has no content to extract ` +
        `(every frame is the background colour).`,
    );
  }
  const union = unionBounds(perFrame.filter((box): box is Bounds => box !== null));
  const { dx, dy } = automaticPlacement(first, union, canvas);

  const placed = keyed.map((frame) =>
    placeOnCanvas(cropTo(frame, union), canvas.width, canvas.height, dx, dy),
  );

  return {
    frames: placed,
    delaysMs: applySpeed(decoded.delaysMs.slice(segment.startFrame, segment.endFrame), speed),
    background: backgroundRecord,
  };
}

/**
 * Apply a Segment's `speed` playback multiplier to the sliced frame delays.
 *
 * `speed` is a playback multiplier (docs/recordings.md): `2` plays the Clip twice
 * as fast, so each frame's duration is **divided** by it; a slowed clip
 * (`speed < 1`) lengthens the delays. It changes pacing only — never the Segment's
 * frame range. The result stays a positive integer (`delaysMs` items have
 * `minimum: 1` in the contract): each value is rounded to the nearest millisecond
 * and clamped to at least `1`.
 */
function applySpeed(delaysMs: number[], speed: number): number[] {
  if (speed === 1) {
    return delaysMs;
  }
  return delaysMs.map((delay) => Math.max(1, Math.round(delay / speed)));
}

/** Inputs for {@link deriveAnchor}. */
export interface DeriveAnchorOptions {
  /** The Recording whose first frame seeds the Anchor. */
  recordingId: string;
  /** A Segment's cut id; the Segment's **first** frame is used. Defaults to frame 0. */
  cutId?: string;
  /** An explicit `#rrggbb` background override; sampled from a corner when omitted. */
  background?: string;
  /** Per-channel key tolerance; defaults to 24. */
  tolerance?: number;
}

/** A derived Anchor plus the symmetric Canvas it implies (user story 42). */
export interface DerivedAnchor {
  /** The source frame index used (the Segment's start, or `0`). */
  frame: number;
  /** The first frame's content box, in source-frame pixels. */
  bounds: Bounds;
  /** The content-box bottom-centre — the derived Anchor. */
  anchor: CanvasAnchor;
  /** A Canvas horizontally symmetric about the Anchor, with it on the bottom edge. */
  canvas: Canvas;
}

/**
 * Derive a Character's Anchor from a Recording (or Segment)'s first frame.
 *
 * User story 42: the Anchor is the first frame's content-box **bottom-centre**.
 * The Canvas is symmetric about the Anchor (`anchor.x == width/2`) with the Anchor
 * on its bottom edge (`anchor.y == height`), so deriving the Anchor also implies
 * the Canvas (docs/alignment.md). The centre is rounded **up** so an odd-width
 * content box still fits. With a `cutId` the Canvas is grown to hold the union of
 * the whole Segment's frames, so extracting it cannot fail on a later frame;
 * without one only the first frame is measured, and the Canvas can be expanded
 * afterwards.
 */
export async function deriveAnchor(
  root: string,
  options: DeriveAnchorOptions,
): Promise<DerivedAnchor> {
  const { recordingId } = options;
  assertValidId(recordingId, 'recording', 'recordingId');
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) {
    throw new StoreError(`Tolerance must be an integer in 0..255; got ${tolerance}.`);
  }

  let startFrame = 0;
  let endFrame = 1;
  if (options.cutId !== undefined) {
    assertValidId(options.cutId, 'cut', 'cutId');
    const segment = await resolveSegment(root, recordingId, options.cutId);
    startFrame = segment.startFrame;
    endFrame = segment.endFrame;
  }

  const bytes = await readSource(root, recordingId);
  const decoded = await decodeSegment(bytes, recordingId, { startFrame, endFrame });
  const frame = decoded.frames[0]!;
  const background: Rgb =
    options.background !== undefined
      ? parseHexColor(options.background)
      : sampleBackgroundColor(decoded.frames);
  const first = contentBounds(keyBackground(frame, background, tolerance));
  if (first === null) {
    throw new StoreError(
      `Cannot derive an Anchor: frame ${startFrame} of Recording "${recordingId}" has no ` +
        `content (every pixel is the background colour).`,
    );
  }

  const anchor: CanvasAnchor = {
    x: Math.ceil(first.x + first.width / 2),
    y: first.y + first.height,
  };
  let canvas: Canvas = { width: 2 * anchor.x, height: anchor.y, anchor };

  // With a Segment, the Canvas must fit **every** frame of it, not just the one
  // the Anchor is read from: extraction re-bakes the whole range and would
  // otherwise fail on a later, larger frame.
  if (options.cutId !== undefined) {
    const union = unionBounds(
      decoded.frames.flatMap((entry) => {
        const box = contentBounds(keyBackground(entry, background, tolerance));
        return box === null ? [] : [box];
      }),
    );
    canvas = canvasFitting(first, union);
  }

  validateArtifact('canvas', canvas);
  return { frame: startFrame, bounds: first, anchor: canvas.anchor, canvas };
}

/**
 * The smallest Canvas that holds `union` with the first frame's foot base on the
 * Anchor, and the Anchor at its bottom-centre (docs/alignment.md).
 */
function canvasFitting(first: Bounds, union: Bounds): Canvas {
  const localX = Math.ceil(first.x - union.x + first.width / 2);
  const localY = first.y - union.y + first.height;
  const half = Math.max(localX, union.width - localX, 1);
  const width = 2 * half;
  const height = localY + union.height;
  return { width, height, anchor: { x: width / 2, y: height } };
}

/**
 * Carry forward the human-editable fields already present on a Draft id, so a
 * re-extract does not silently discard the Repair script reference or the framing
 * the offset/script were authored against. A Draft that does not exist yields `{}`.
 */
async function readPreservedDraftState(
  root: string,
  characterId: string,
  draftId: string,
): Promise<Partial<ClipDraftDescriptor>> {
  const artifactPath = draftPath(characterId, draftId);
  if (!(await pathExists(root, artifactPath))) {
    return {};
  }
  const value = (await readJsonFile(root, artifactPath)) as ClipDraftDescriptor;
  const preserved: Partial<ClipDraftDescriptor> = {};
  if (value.derivedFrom !== undefined) preserved.derivedFrom = value.derivedFrom;
  if (value.placementOffset) preserved.placementOffset = value.placementOffset;
  if (value.placementFraming) preserved.placementFraming = value.placementFraming;
  if (value.repair) preserved.repair = value.repair;
  if (value.repairFraming) preserved.repairFraming = value.repairFraming;
  return preserved;
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

/** Read the Recording's source bytes, verifying them against the recorded hash when given. */
async function readSource(root: string, recordingId: string, hash?: string): Promise<Buffer> {
  const sourceRelPath = sourcePath(recordingId);
  if (!(await pathExists(root, sourceRelPath))) {
    throw new StoreError(
      `Recording "${recordingId}" has no recording file (${sourceRelPath} is missing).`,
    );
  }
  const bytes = await readBinaryFile(root, sourceRelPath);
  if (hash === undefined) {
    return bytes;
  }
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== hash) {
    throw new StoreError(
      `Recording "${recordingId}" file does not match its recorded hash; ` +
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
      `Cannot decode recording file for "${recordingId}": ${(error as Error).message}`,
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
const DRAFT_OPTIONAL_KEYS = [
  'derivedFrom',
  'placementOffset',
  'placementFraming',
  'repair',
  'repairFraming',
] as const;

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
  if ('repairFraming' in value && value.repairFraming !== undefined) {
    const framing = value.repairFraming;
    if (
      !isRecord(framing) ||
      !isInteger(framing.frameCount) ||
      (framing.frameCount as number) < 1 ||
      !isInteger(framing.width) ||
      (framing.width as number) < 1 ||
      !isInteger(framing.height) ||
      (framing.height as number) < 1
    ) {
      issue('/repairFraming', 'must be {frameCount, width, height} of positive integers');
    }
  }

  if ('placementFraming' in value && value.placementFraming !== undefined) {
    const framing = value.placementFraming;
    if (
      !isRecord(framing) ||
      !isInteger(framing.frameCount) ||
      (framing.frameCount as number) < 1 ||
      !isInteger(framing.width) ||
      (framing.width as number) < 1 ||
      !isInteger(framing.height) ||
      (framing.height as number) < 1
    ) {
      issue('/placementFraming', 'must be {frameCount, width, height} of positive integers');
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
