/**
 * `repair` — hand-editing a de-backgrounded Clip as a replayable operation script.
 *
 * Repair runs on the RGBA frames **after** de-backgrounding and alignment, so
 * painting **transparent** erases and painting a **picked colour** patches
 * (docs/repair.md, GLOSSARY.md). Edits are stored as an ordered **Repair script**
 * at `characters/<character-id>/repairs/<clip-id>/repair.json` — not a flattened
 * raster — and replayed in order, so a repaired Clip is reproducible from its
 * inputs (ADR-0005, format-spec §4).
 *
 * The script is also the **undo stack**: undo removes the last operation. It is
 * written on every operation, so a reload loses nothing.
 *
 * Three operation kinds share the frame targeting, the undo stack and the replay:
 * `erase-rect` (a bulk-clear fast path, not a separate mechanism — Rule 4.1),
 * `erase-brush` and `paint-brush`. Each targets a half-open frame range, so one
 * edit covers a single frame or a whole span. Alpha is **binary** (Rule 4.2):
 * erasing writes `0`, painting writes `255` at the given colour.
 *
 * Everything except the store-backed verbs is **pure** over in-memory RGBA
 * images; only the script verbs touch the filesystem, through `./store/`.
 */

import { parseHexColor, toHexColor, type Rgb, type RgbaImage } from './background.js';
import {
  readClipDraft,
  readClipDraftFrame,
  writeClipDraft,
  type ClipDraftDescriptor,
  type ClipDraftFrame,
} from './draft.js';
import { StoreError, ValidationError, type ValidationIssue } from './errors.js';
import { isValidId } from './ids.js';
import { canvasPath, repairPath } from './layout.js';
import { pathExists, readJsonFile, removePath, writeJsonFile } from './store/index.js';
import { validateArtifact } from './validate.js';
import sharp from 'sharp';

/** The three Repair operation kinds (format-spec §4). */
export type RepairTool = 'erase-rect' | 'erase-brush' | 'paint-brush';

/** A half-open frame range: one frame (`end == start + 1`) or a span. */
export interface FrameRange {
  /** Inclusive first frame. */
  start: number;
  /** Exclusive end of the range. */
  end: number;
}

/** The geometry of an `erase-rect` operation: position and size in pixels. */
export interface RectGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The geometry of a brush operation: a polyline of pixel coordinates at a size. */
export interface StrokeGeometry {
  /** Each point is `[x, y]`, in Canvas pixel coordinates. */
  points: Array<[number, number]>;
  /** The brush's side length in pixels. */
  size: number;
}

/** One Repair operation (format-spec §4). */
export interface RepairOperation {
  tool: RepairTool;
  frames: FrameRange;
  geometry: RectGeometry | StrokeGeometry;
  /** `#rrggbb`; required for `paint-brush`, forbidden for the erase tools. */
  color?: string;
}

/** A Repair operation as supplied by a caller: `color` is optional until validated. */
export type RepairOperationInput = Omit<RepairOperation, 'color'> & { color?: string };

/** An ordered list of Repair operations; replayed in order on every run. */
export interface RepairScript {
  operations: RepairOperation[];
}

/** The pixel geometry a Repair script is valid against (Rule 4.3). */
export interface RepairFraming {
  /** Number of frames in the Clip. */
  frameCount: number;
  /** Frame width in pixels (the Character's Canvas width). */
  width: number;
  /** Frame height in pixels (the Character's Canvas height). */
  height: number;
}

/** The kind of a validity problem in {@link RepairWarning}. */
export type RepairWarningCode = 'framing-changed' | 'frames-out-of-range' | 'geometry-out-of-bounds';

/** A reported Repair-validity problem; the tool warns rather than silently misapplying. */
export interface RepairWarning {
  code: RepairWarningCode;
  /** A human-readable explanation, naming the offending operation when there is one. */
  message: string;
}

/** A Draft's Repair state: the ordered operations plus any validity warnings. */
export interface RepairState {
  operations: RepairOperation[];
  warnings: RepairWarning[];
}

/** Inputs for the script-level read/write verbs (keyed by Clip id). */
export interface RepairClipOptions {
  characterId: string;
  /** The editable Clip state's id: a Draft id while uncommitted, an Asset id after commit. */
  clipId: string;
}

/** Inputs for {@link readDraftRepair} / {@link undoRepairOperation}. */
export interface DraftRepairOptions {
  characterId: string;
  draftId: string;
}

/** Inputs for {@link appendRepairOperation}. */
export interface AppendRepairOptions extends DraftRepairOptions {
  operation: RepairOperationInput;
}

// --- script CRUD (keyed by Clip id) ------------------------------------------

/**
 * Read a Clip's Repair script. A Clip with no Repair has no file and reads back
 * as `{ operations: [] }` — an empty script is the "no Repair yet" state.
 */
export async function readRepairScript(
  root: string,
  options: RepairClipOptions,
): Promise<RepairScript> {
  const { characterId, clipId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(clipId, 'clip', 'clipId');

  const artifactPath = repairPath(characterId, clipId);
  if (!(await pathExists(root, artifactPath))) {
    return { operations: [] };
  }
  const value = await readJsonFile(root, artifactPath);
  validateRepairScript(value, artifactPath);
  return value as RepairScript;
}

/** Write (validated) a Clip's Repair script. */
export async function writeRepairScript(
  root: string,
  options: RepairClipOptions,
  script: RepairScript,
): Promise<void> {
  const { characterId, clipId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(clipId, 'clip', 'clipId');
  const artifactPath = repairPath(characterId, clipId);
  validateRepairScript(script, artifactPath);
  await writeJsonFile(root, artifactPath, script);
}

// --- Draft-level verbs (the editable Clip state) ------------------------------

/** Read the active Draft's Repair state: its operations plus validity warnings. */
export async function readDraftRepair(
  root: string,
  options: DraftRepairOptions,
): Promise<RepairState> {
  const { characterId, draftId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(draftId, 'draft', 'draftId');

  const draft = await readClipDraft(root, { characterId, draftId });
  const framing = await currentFraming(root, characterId, draft.frameCount);
  const script = await readRepairScript(root, { characterId, clipId: draftId });
  const warnings = checkRepairValidity(script, framing, draft.repairFraming);
  return { operations: script.operations, warnings };
}

/**
 * Append one Repair operation to the Draft's script and write it.
 *
 * The operation is validated before anything is written (a `paint-brush` without
 * a colour, or an erase with one, is a hard error). The Draft's `repairFraming`
 * is recorded on the first operation, so a later change to the frames or Canvas
 * can be detected (Rule 4.3).
 */
export async function appendRepairOperation(
  root: string,
  options: AppendRepairOptions,
): Promise<RepairState> {
  const { characterId, draftId, operation } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(draftId, 'draft', 'draftId');

  const draft = await readClipDraft(root, { characterId, draftId });
  const framing = await currentFraming(root, characterId, draft.frameCount);

  const script = await readRepairScript(root, { characterId, clipId: draftId });
  const next: RepairScript = { operations: [...script.operations, operation as RepairOperation] };
  // Validate the whole next script before writing any of it.
  validateRepairScript(next, repairPath(characterId, draftId));
  await writeRepairScript(root, { characterId, clipId: draftId }, next);

  if (!draft.repairFraming) {
    // Destructure off the read-back directory/frame paths: the descriptor itself
    // is a closed object.
    const { dir: _dir, frames: _frames, ...descriptor } = draft;
    const nextDescriptor: ClipDraftDescriptor = {
      ...descriptor,
      repair: descriptor.repair ?? repairPath(characterId, draftId),
      repairFraming: framing,
    };
    await writeClipDraft(root, nextDescriptor);
    return { operations: next.operations, warnings: checkRepairValidity(next, framing, framing) };
  }

  const warnings = checkRepairValidity(next, framing, draft.repairFraming);
  return { operations: next.operations, warnings };
}

/**
 * Undo the last Repair operation: pop it from the script and write the result.
 * Undo on an empty (or absent) script is a no-op that still leaves a valid script.
 */
export async function undoRepairOperation(
  root: string,
  options: DraftRepairOptions,
): Promise<RepairState> {
  const { characterId, draftId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(draftId, 'draft', 'draftId');

  const draft = await readClipDraft(root, { characterId, draftId });
  const framing = await currentFraming(root, characterId, draft.frameCount);

  const script = await readRepairScript(root, { characterId, clipId: draftId });
  const next: RepairScript = { operations: script.operations.slice(0, -1) };
  await writeRepairScript(root, { characterId, clipId: draftId }, next);

  const warnings = checkRepairValidity(next, framing, draft.repairFraming);
  return { operations: next.operations, warnings };
}

/**
 * Re-home a Draft's script onto the committed Asset id and point the Draft at it,
 * so the provenance's `repair` reference and the script file agree. Called by
 * commit (the fork seam #24 opened). A Draft with no script is left alone.
 */
export async function rehomeRepairScript(
  root: string,
  characterId: string,
  draftId: string,
  assetId: string,
): Promise<string | null> {
  const from = repairPath(characterId, draftId);
  if (!(await pathExists(root, from))) {
    return null;
  }
  const to = repairPath(characterId, assetId);
  if (from !== to) {
    const script = await readRepairScript(root, { characterId, clipId: draftId });
    await writeRepairScript(root, { characterId, clipId: assetId }, script);
    // Drop the Draft's old script folder; the Asset id now owns the script.
    await removePath(root, `characters/${characterId}/repairs/${draftId}`);
  }
  return to;
}

/**
 * Copy a parent Asset's Repair script to a fork's Draft id, so the new branch
 * starts from the parent's Repair (docs/architecture.md, "Repair script").
 * Returns the copied script's path, or `null` when the parent has no script.
 */
export async function copyRepairScript(
  root: string,
  characterId: string,
  parentClipId: string,
  draftId: string,
): Promise<string | null> {
  const from = repairPath(characterId, parentClipId);
  if (!(await pathExists(root, from))) {
    return null;
  }
  const script = await readRepairScript(root, { characterId, clipId: parentClipId });
  await writeRepairScript(root, { characterId, clipId: draftId }, script);
  return repairPath(characterId, draftId);
}

/** Inputs for {@link readDraftRepairFrame}. */
export interface ReadDraftRepairFrameOptions extends DraftRepairOptions {
  /** Zero-based frame index within the Draft. */
  index: number;
}

/**
 * Read one Draft frame as PNG bytes with the Draft's Repair script replayed
 * (the Clip editor shows the repaired result). With no Repair the raw frame bytes
 * are returned unchanged.
 */
export async function readDraftRepairFrame(
  root: string,
  options: ReadDraftRepairFrameOptions,
): Promise<ClipDraftFrame> {
  const { characterId, draftId, index } = options;
  const raw = await readClipDraftFrame(root, { characterId, draftId, index });
  const script = await readRepairScript(root, { characterId, clipId: draftId });
  if (script.operations.length === 0) {
    return raw;
  }
  const frame = await decodeRgba(raw.data);
  const repaired = applyRepairScriptToFrame(frame, index, script);
  return { path: raw.path, contentType: 'image/png', data: await encodePng(repaired) };
}

/** Inputs for {@link sampleDraftRepairColor} — the eyedropper on a Draft frame. */
export interface SampleDraftRepairColorOptions extends DraftRepairOptions {
  /** Zero-based frame index within the Draft. */
  index: number;
  /** Sample x, in Canvas pixels. */
  x: number;
  /** Sample y, in Canvas pixels. */
  y: number;
}

/**
 * Sample a pixel of a Draft's **de-backgrounded** frame — the eyedropper. Returns
 * `#rrggbb`; painting with it writes opaque (Rule 4.2).
 */
export async function sampleDraftRepairColor(
  root: string,
  options: SampleDraftRepairColorOptions,
): Promise<string> {
  const { characterId, draftId, index, x, y } = options;
  const raw = await readClipDraftFrame(root, { characterId, draftId, index });
  const frame = await decodeRgba(raw.data);
  return samplePixelColor(frame, x, y);
}

// --- pure: replay, sampling, validity ----------------------------------------
/**
 * Replay a Repair script over the frames, returning new images (the inputs are
 * not mutated). Operations apply in order to every frame in their half-open
 * range; frame indices outside the Clip are skipped and geometry is clamped to
 * the frame, so a stale script can never write out of bounds (Rule 4.3 warns
 * separately).
 */
export function applyRepairScript(
  frames: readonly RgbaImage[],
  script: RepairScript,
): RgbaImage[] {
  return frames.map((frame, index) => applyRepairScriptToFrame(frame, index, script));
}

/** Replay only the operations that target `index` onto one frame (the inputs are not mutated). */
export function applyRepairScriptToFrame(
  frame: RgbaImage,
  index: number,
  script: RepairScript,
): RgbaImage {
  const out: RgbaImage = {
    width: frame.width,
    height: frame.height,
    data: new Uint8Array(frame.data),
  };
  for (const operation of script.operations) {
    if (index >= operation.frames.start && index < operation.frames.end) {
      applyOperation(out, operation);
    }
  }
  return out;
}

/**
 * Sample the colour at a pixel of a de-backgrounded frame — the eyedropper. The
 * sample is painted **opaque** (Rule 4.2), so only `#rrggbb` comes back.
 */
export function samplePixelColor(frame: RgbaImage, x: number, y: number): string {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    throw new StoreError(
      `Cannot sample (${x}, ${y}): outside the ${frame.width}x${frame.height} frame.`,
    );
  }
  const at = (y * frame.width + x) * 4;
  const color: Rgb = { r: frame.data[at]!, g: frame.data[at + 1]!, b: frame.data[at + 2]! };
  return toHexColor(color);
}

/**
 * Report the ways `script` is not coordinate-valid for `framing` (Rule 4.3).
 *
 * `authoredFraming` is the framing recorded when the script was first written; a
 * difference from `framing` means the Clip's frames or Canvas changed since, so
 * the geometry may no longer line up. Out-of-range frame targets and
 * out-of-bounds geometry are reported per operation.
 */
export function checkRepairValidity(
  script: RepairScript,
  framing: RepairFraming,
  authoredFraming?: RepairFraming,
): RepairWarning[] {
  const warnings: RepairWarning[] = [];

  if (
    authoredFraming &&
    (authoredFraming.frameCount !== framing.frameCount ||
      authoredFraming.width !== framing.width ||
      authoredFraming.height !== framing.height)
  ) {
    warnings.push({
      code: 'framing-changed',
      message:
        `The Repair script was authored for ${authoredFraming.frameCount} frame(s) on a ` +
        `${authoredFraming.width}x${authoredFraming.height} Canvas, but the Clip is now ` +
        `${framing.frameCount} on ${framing.width}x${framing.height}; its geometry may no longer line up.`,
    });
  }

  script.operations.forEach((operation, index) => {
    const { start, end } = operation.frames;
    if (start >= framing.frameCount || end > framing.frameCount) {
      warnings.push({
        code: 'frames-out-of-range',
        message:
          `Operation ${index} (${operation.tool}) targets frames [${start}, ${end}), ` +
          `outside the Clip's ${framing.frameCount} frame(s).`,
      });
    }
    if (!geometryWithin(operation.geometry, framing)) {
      warnings.push({
        code: 'geometry-out-of-bounds',
        message:
          `Operation ${index} (${operation.tool}) draws outside the ` +
          `${framing.width}x${framing.height} Canvas.`,
      });
    }
  });

  return warnings;
}

// --- internals ----------------------------------------------------------------

/** Apply one operation to one frame, in place. */
function applyOperation(frame: RgbaImage, operation: RepairOperation): void {
  const { tool, geometry } = operation;
  if (tool === 'erase-rect') {
    const rect = geometry as RectGeometry;
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(frame.width, rect.x + rect.width);
    const y1 = Math.min(frame.height, rect.y + rect.height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        frame.data[(y * frame.width + x) * 4 + 3] = 0;
      }
    }
    return;
  }

  const stroke = geometry as StrokeGeometry;
  const color = tool === 'paint-brush' ? parseHexColor(operation.color!) : null;
  const points = expandStroke(stroke.points);
  for (const [cx, cy] of points) {
    stamp(frame, cx, cy, stroke.size, color);
  }
}

/** Stamp a `size`x`size` square at `(cx, cy)`; `color` paints opaque, `null` erases. */
function stamp(frame: RgbaImage, cx: number, cy: number, size: number, color: Rgb | null): void {
  const half = Math.floor((size - 1) / 2);
  const x0 = Math.max(0, cx - half);
  const y0 = Math.max(0, cy - half);
  const x1 = Math.min(frame.width, cx - half + size);
  const y1 = Math.min(frame.height, cy - half + size);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * frame.width + x) * 4;
      if (color) {
        frame.data[at] = color.r;
        frame.data[at + 1] = color.g;
        frame.data[at + 2] = color.b;
        frame.data[at + 3] = 255;
      } else {
        frame.data[at + 3] = 0;
      }
    }
  }
}

/** Rasterise a stroke polyline: every point plus the pixels between consecutive points. */
function expandStroke(points: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i]!;
    out.push([x, y]);
    if (i > 0) {
      const [px, py] = points[i - 1]!;
      out.push(...linePoints(px, py, x, y));
    }
  }
  return out;
}

/** Bresenham's line, excluding the first point (already emitted). */
function linePoints(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (x !== x1 || y !== y1) {
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    points.push([x, y]);
  }
  return points;
}

/** Decode PNG bytes into a raw RGBA image. */
async function decodeRgba(bytes: Buffer): Promise<RgbaImage> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/** Encode a raw RGBA image as PNG. */
async function encodePng(image: RgbaImage): Promise<Buffer> {
  return sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/** Is a geometry fully inside the frame's pixel bounds? */
function geometryWithin(geometry: RectGeometry | StrokeGeometry, framing: RepairFraming): boolean {
  if ('points' in geometry) {
    return geometry.points.every(
      ([x, y]) => x >= 0 && y >= 0 && x < framing.width && y < framing.height,
    );
  }
  return (
    geometry.x >= 0 &&
    geometry.y >= 0 &&
    geometry.x + geometry.width <= framing.width &&
    geometry.y + geometry.height <= framing.height
  );
}

/** The current framing for a Clip: its frame count and the Character's Canvas size. */
async function currentFraming(
  root: string,
  characterId: string,
  frameCount: number,
): Promise<RepairFraming> {
  const artifactPath = canvasPath(characterId);
  if (!(await pathExists(root, artifactPath))) {
    throw new StoreError(`No Character "${characterId}" in the store (${artifactPath} is missing).`);
  }
  const value = await readJsonFile(root, artifactPath);
  validateArtifact('canvas', value, { artifact: artifactPath });
  const canvas = value as { width: number; height: number };
  return { frameCount, width: canvas.width, height: canvas.height };
}

/** Validate a Repair script against the frozen schema, then the rules it cannot express. */
function validateRepairScript(value: unknown, artifact: string): void {
  validateArtifact('repair', value, { artifact });
  const issues: ValidationIssue[] = [];
  const script = value as RepairScript;
  script.operations.forEach((operation, index) => {
    if (!(operation.frames.end > operation.frames.start)) {
      issues.push({
        artifact,
        path: `/operations/${index}/frames`,
        message: `end (${operation.frames.end}) must be greater than start (${operation.frames.start})`,
      });
    }
  });
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
}

/** Reject an id that does not match the id grammar before it becomes a path segment. */
function assertValidId(id: string, noun: string, label: string): void {
  if (!isValidId(id)) {
    throw new StoreError(`Invalid ${label} "${id}" (${noun} id): must match /^[a-z][a-z0-9-]*$/.`);
  }
}
