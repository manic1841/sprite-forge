/**
 * `alignment` — placing Clips on the Character's shared Canvas.
 *
 * Alignment is a property of the **Character**, not of an individual Asset: every
 * Asset is drawn on the same Canvas and aligned by the same Anchor (docs/alignment.md).
 * This module owns the two Character-level operations on top of that:
 *
 *   - the per-Clip manual **placement offset** — a pure translation on top of the
 *     automatic Anchor placement, recorded in a Draft's descriptor and carried
 *     into the committed provenance (`{0,0}` is omitted);
 *   - the explicit **expand canvas** — the one deliberate, Character-wide re-bake
 *     (ADR-0006): grow the Canvas about the Anchor and re-bake every committed Clip.
 *
 * It also frames a blank Character from footage (`frameCanvasFromSegment`): a
 * Character can exist before any Recording does, so its provisional Canvas has to
 * be replaceable by real framing rather than sitting there forever.
 *
 * The offset is applied at bake time (`commitDraft`) and in this module's reads;
 * the Draft's stored frames remain the automatic placement, so a Repair script —
 * authored against those frames — stays valid when only the offset moves. Only a
 * change to the *frames* or the *Canvas* invalidates alignment, and then the tool
 * **warns** rather than silently misapplying (docs/alignment.md, "Validity").
 */

import sharp from 'sharp';
import { rebakeSequenceSheet } from './assets.js';
import type { RgbaImage } from './background.js';
import type { Canvas } from './character.js';
import { deriveAnchor } from './draft.js';
import { readClipDraft, writeClipDraft, type ClipDraft } from './draft.js';
import { StoreError } from './errors.js';
import { contentBounds, placeOnCanvas } from './frames.js';
import { assertValidId } from './ids.js';
import {
  assetMetaPath,
  assetProvenancePath,
  canvasPath,
  clipsDir,
  draftPath,
  draftsDir,
  repairPath,
  sequencesDir,
  sheetPath,
} from './layout.js';
import {
  checkRepairValidity,
  readRepairScript,
  type RepairFraming,
  type RepairWarning,
} from './repair.js';
import {
  listDirectories,
  pathExists,
  readBinaryFile,
  readJsonFile,
  writeBinaryFile,
  writeJsonFile,
} from './store/index.js';
import { validateArtifact } from './validate.js';

/** A manual placement on top of the automatic Anchor, in Canvas pixels. */
export interface PlacementOffset {
  x: number;
  y: number;
}

/** The kind of an alignment-validity problem in {@link AlignmentWarning}. */
export type AlignmentWarningCode = 'alignment-framing-changed';

/** A reported alignment-validity problem; the tool warns rather than misapplying. */
export interface AlignmentWarning {
  code: AlignmentWarningCode;
  message: string;
}

/** A Draft's alignment state: its offset plus any validity warnings. */
export interface AlignmentState {
  /** The manual offset; `{0,0}` when there is none. */
  offset: PlacementOffset;
  warnings: AlignmentWarning[];
}

/** Inputs for {@link setPlacementOffset}. */
export interface SetPlacementOffsetOptions {
  characterId: string;
  draftId: string;
  offset: PlacementOffset;
}

/** Inputs for {@link readDraftAlignment} / {@link expandCanvas}. */
export interface CharacterScopedOptions {
  characterId: string;
}

/** Inputs for {@link readDraftAlignment}. */
export interface ReadDraftAlignmentOptions extends CharacterScopedOptions {
  draftId: string;
}

/** Inputs for {@link resizeCanvas}. */
export interface ResizeCanvasOptions extends CharacterScopedOptions {
  /** The new Canvas width; a positive even integer at least the content floor. */
  width: number;
  /** The new Canvas height; a positive integer at least the content floor. */
  height: number;
}

/** The result of {@link resizeCanvas}. */
export interface ResizeCanvasResult {
  /** The new Canvas/Anchor as written to `canvas.json`. */
  canvas: Canvas;
  /** The committed Clip ids that were re-baked to the new Canvas. */
  rebakedClips: string[];
  /**
   * The committed Sequence ids that were re-baked to the new Canvas. A Sequence's
   * frames are the concatenation of its source Clips' frames, so re-placing the
   * Clips (above) and re-concatenating keeps the Sequence correct; it is never
   * silently skipped.
   */
  rebakedSequences: string[];
  /**
   * Repair-validity warnings for the Character's committed Clips: an expand moves
   * the pixels a committed Clip's Repair script was authored against. Draft
   * warnings are surfaced by `readDraftRepair` (this list deliberately omits them
   * so the two do not double-report).
   */
  repairWarnings: RepairWarning[];
}

/** The smallest Canvas the Character's content allows, per {@link contentFloor}. */
export interface ContentFloor {
  /** Even, at least 2. */
  width: number;
  /** At least 1. */
  height: number;
  /**
   * Whether anything is actually drawn. With nothing drawn the Canvas can be
   * resized freely (and a fit is a no-op), so the floor is only advisory.
   */
  hasContent: boolean;
}

/** A Character's Clips/Drafts and their offsets, for the Alignment stage. */
export interface CharacterAlignment {
  canvas: Canvas;
  /**
   * The smallest Canvas the drawn content still fits on. Shrinking below it would
   * crop, so the Alignment face shows it as the floor for the size inputs.
   */
  contentFloor: ContentFloor;
  /** `frameCount` is carried so a Clip's ghost can show one frame, not its whole sheet. */
  clips: Array<{ id: string; frameCount: number; placementOffset?: PlacementOffset }>;
  drafts: Array<{ id: string; placementOffset?: PlacementOffset }>;
}

/**
 * Set (or clear) a Draft's manual placement offset.
 *
 * The offset is recorded on the Draft's descriptor, omitted when `{0,0}`. It is
 * **not** baked into the Draft's stored frames: it is re-applied whenever the
 * Clip is baked (`commitDraft`) or shown aligned, so the offset is a property of
 * placement rather than a destructive edit. The Canvas the offset was chosen
 * against is recorded too, so a later expand can warn that it is stale.
 */
export async function setPlacementOffset(
  root: string,
  options: SetPlacementOffsetOptions,
): Promise<ClipDraft> {
  const { characterId, draftId, offset } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(draftId, 'draft', 'draftId');
  assertOffset(offset);

  const draft = await readClipDraft(root, { characterId, draftId });
  const canvas = await readCanvas(root, characterId);

  const { dir: _dir, frames: _frames, ...descriptor } = draft;
  if (isZero(offset)) {
    delete descriptor.placementOffset;
    delete descriptor.placementFraming;
  } else {
    descriptor.placementOffset = { x: offset.x, y: offset.y };
    descriptor.placementFraming = framingOf(canvas, draft.frameCount);
  }
  await writeClipDraft(root, descriptor);
  return readClipDraft(root, { characterId, draftId });
}

/** Read a Draft's placement offset plus any alignment-validity warnings. */
export async function readDraftAlignment(
  root: string,
  options: ReadDraftAlignmentOptions,
): Promise<AlignmentState> {
  const { characterId, draftId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(draftId, 'draft', 'draftId');

  const draft = await readClipDraft(root, { characterId, draftId });
  const canvas = await readCanvas(root, characterId);
  return {
    offset: draft.placementOffset ?? { x: 0, y: 0 },
    warnings: checkAlignmentValidity(draft.placementFraming, framingOf(canvas, draft.frameCount)),
  };
}

/**
 * Resize the Character's Canvas and re-bake everything drawn on it
 * (ADR-0014, superseding the grow-only rule of ADR-0006).
 *
 * The new Canvas stays symmetric about the Anchor (`anchor.x == width/2`,
 * `anchor.y == height`). Because the Anchor is the bottom-centre reused for every
 * Asset, resizing is a pure translation of the existing content: every committed
 * Clip's sheet frames and every Draft's frames are moved by
 * `((newWidth - oldWidth)/2, newHeight - oldHeight)`. Growing leaves the content
 * alone; shrinking crops only what lies outside, which {@link contentFloor} keeps
 * to transparent margin. Every committed Sequence is re-concatenated from its
 * re-placed Clips. Old sheets are overwritten — the store is working data, and git
 * is the history.
 */
export async function resizeCanvas(
  root: string,
  options: ResizeCanvasOptions,
): Promise<ResizeCanvasResult> {
  const { characterId, width, height } = options;
  assertValidId(characterId, 'character', 'characterId');

  const old = await readCanvas(root, characterId);
  if (!Number.isInteger(width) || width < 1 || width % 2 !== 0) {
    throw new StoreError(
      `Canvas width must be a positive even integer so the Anchor can sit at its ` +
        `integer centre (anchor.x == width/2); got ${width}.`,
    );
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new StoreError(`Canvas height must be a positive integer; got ${height}.`);
  }

  // Shrinking is allowed down to the content's own bounds: below that the re-bake
  // would crop pixels the user probably still wants, so the floor is enforced and
  // named rather than silently trimming. With nothing drawn there is no floor.
  const floor = await contentFloor(root, { characterId });
  if (floor.hasContent && (width < floor.width || height < floor.height)) {
    throw new StoreError(
      `Canvas cannot shrink below the content: ${characterId} needs at least ` +
        `${floor.width}x${floor.height} (asked for ${width}x${height}).`,
    );
  }

  const canvas: Canvas = { width, height, anchor: { x: width / 2, y: height } };
  validateArtifact('canvas', canvas, { artifact: canvasPath(characterId) });

  if (width === old.width && height === old.height) {
    return { canvas: old, rebakedClips: [], rebakedSequences: [], repairWarnings: [] };
  }

  const dx = (width - old.width) / 2;
  const dy = height - old.height;

  // 1. Re-bake every committed Clip onto the new Canvas.
  const rebakedClips: string[] = [];
  const repairWarnings: RepairWarning[] = [];
  for (const clipId of await listDirectories(root, clipsDir(characterId))) {
    const meta = await readClipMeta(root, characterId, clipId);
    await rebakeSheet(root, characterId, clipId, meta.frameCount, old, canvas, dx, dy);
    rebakedClips.push(clipId);

    if (await pathExists(root, repairPath(characterId, clipId))) {
      // The script was authored against the old Canvas; report if its geometry no
      // longer lines up rather than silently misapplying it (format-spec Rule 4.3).
      const script = await readRepairScript(root, { characterId, clipId });
      repairWarnings.push(
        ...checkRepairValidity(
          script,
          framingOf(canvas, meta.frameCount),
          framingOf(old, meta.frameCount),
        ),
      );
    }
  }

  // 2. Re-place every Draft's frames (the `placementFraming` stays old, so the
  //    alignment read now warns that the offset is stale).
  for (const draftId of await listDirectories(root, draftsDir(characterId))) {
    if (!(await pathExists(root, draftPath(characterId, draftId)))) {
      continue;
    }
    await replaceDraftFrames(root, characterId, draftId, old, canvas, dx, dy);
  }

  // 3. Re-bake every committed Sequence now its source Clips have been re-placed:
  //    a Sequence's sheet is the concatenation of its Clips' (now expanded) strips.
  const rebakedSequences: string[] = [];
  for (const sequenceId of await listDirectories(root, sequencesDir(characterId))) {
    await rebakeSequenceSheet(root, { characterId, sequenceId, canvas });
    rebakedSequences.push(sequenceId);
  }

  // The Canvas is written last, so a failed re-bake leaves the old Canvas intact.
  await writeJsonFile(root, canvasPath(characterId), canvas);

  return { canvas, rebakedClips, rebakedSequences, repairWarnings };
}

/** Inputs for {@link frameCanvasFromSegment}. */
export interface FrameCanvasFromSegmentOptions {
  characterId: string;
  /** The Recording the framing is read from. */
  recordingId: string;
  /** The Segment whose frames size the Canvas; omitted uses the Recording's frame 0. */
  cutId?: string;
}

/**
 * Frame a **blank** Character from footage.
 *
 * A Character created ahead of any footage starts on a provisional Canvas
 * ({@link BLANK_CANVAS}); this replaces it with the framing the footage implies, so
 * the placeholder is never left in place by accident.
 *
 * A Character that already has work still cannot be cropped blindly: the Canvas
 * is resized through {@link resizeCanvas}, whose content floor refuses a size
 * below the pixels already drawn.
 */
export async function frameCanvasFromSegment(
  root: string,
  options: FrameCanvasFromSegmentOptions,
): Promise<Canvas> {
  const { characterId, recordingId, cutId } = options;
  assertValidId(characterId, 'character', 'characterId');

  const derived = await deriveAnchor(root, {
    recordingId,
    ...(cutId === undefined ? {} : { cutId }),
  });
  const canvas = derived.canvas;
  const old = await readCanvas(root, characterId);

  if (old.width === canvas.width && old.height === canvas.height) {
    return old;
  }

  const drawn =
    (await listDirectories(root, clipsDir(characterId))).length > 0 ||
    (await listDirectories(root, draftsDir(characterId))).length > 0 ||
    (await listDirectories(root, sequencesDir(characterId))).length > 0;

  if (!drawn) {
    validateArtifact('canvas', canvas, { artifact: canvasPath(characterId) });
    await writeJsonFile(root, canvasPath(characterId), canvas);
    return canvas;
  }

  // Drawn on: re-bake through the resize path, which also guards the content
  // floor when the derived framing is smaller than what is already drawn.
  const resized = await resizeCanvas(root, {
    characterId,
    width: canvas.width,
    height: canvas.height,
  });
  return resized.canvas;
}

/**
 * The smallest Canvas the Character's drawn content still fits on.
 *
 * Measured from every committed Clip's sheet and every Draft's frames, with each
 * artifact's `placementOffset` added because that is what a bake applies. The
 * floor is symmetric about the Anchor, so it is always even and never below 2x1.
 * All-transparent frames contribute nothing — a frame with no pixels cannot be
 * cropped further, and a Character with nothing drawn reports `hasContent: false`
 * with the bare 2x1 minimum.
 *
 * This is what lets {@link resizeCanvas} shrink safely: down to here only
 * transparent margin is lost.
 */
export async function contentFloor(
  root: string,
  options: CharacterScopedOptions,
): Promise<ContentFloor> {
  const { characterId } = options;
  assertValidId(characterId, 'character', 'characterId');

  const canvas = await readCanvas(root, characterId);
  const anchorX = canvas.anchor.x;
  const anchorY = canvas.anchor.y;
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;

  const measure = (image: RgbaImage, offset: PlacementOffset = { x: 0, y: 0 }): void => {
    const bounds = contentBounds(image);
    if (bounds === null) {
      return;
    }
    const minX = bounds.x + offset.x;
    const maxX = bounds.x + bounds.width + offset.x;
    const minY = bounds.y + offset.y;
    const maxY = bounds.y + bounds.height + offset.y;
    left = Math.max(left, anchorX - minX);
    right = Math.max(right, maxX - anchorX);
    top = Math.max(top, anchorY - minY);
    bottom = Math.max(bottom, maxY - anchorY);
  };

  for (const clipId of await listDirectories(root, clipsDir(characterId))) {
    const metaRel = assetMetaPath(characterId, 'clip', clipId);
    if (!(await pathExists(root, metaRel))) {
      continue;
    }
    const meta = (await readJsonFile(root, metaRel)) as { frameCount: number };
    let decoded: { data: Buffer; info: { width: number; height: number } };
    try {
      decoded = await sharp(await readBinaryFile(root, sheetPath(characterId, 'clip', clipId)))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch {
      // An unreadable sheet is a validation problem of its own; the floor should
      // still answer for the rest of the Character.
      continue;
    }
    const { data, info } = decoded;
    // The placement offset is already baked into a committed sheet; only the
    // per-frame cell has to be lifted out of it.
    for (let index = 0; index < meta.frameCount; index++) {
      const frame: RgbaImage = {
        width: canvas.width,
        height: canvas.height,
        data: new Uint8Array(canvas.width * canvas.height * 4),
      };
      for (let y = 0; y < canvas.height; y++) {
        const from = (y * info.width + index * canvas.width) * 4;
        frame.data.set(data.subarray(from, from + canvas.width * 4), y * canvas.width * 4);
      }
      measure(frame);
    }
  }

  for (const draftId of await listDirectories(root, draftsDir(characterId))) {
    if (!(await pathExists(root, draftPath(characterId, draftId)))) {
      continue;
    }
    const draft = await readClipDraft(root, { characterId, draftId });
    const offset = draft.placementOffset ?? { x: 0, y: 0 };
    for (const frameRel of draft.frames) {
      let decoded: { data: Buffer; info: { width: number; height: number } };
      try {
        decoded = await sharp(await readBinaryFile(root, frameRel))
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
      } catch {
        continue;
      }
      const { data, info } = decoded;
      measure(
        { width: info.width, height: info.height, data: new Uint8Array(data) },
        offset,
      );
    }
  }

  return {
    width: Math.max(2, 2 * Math.ceil(Math.max(left, right))),
    height: Math.max(1, Math.ceil(top + bottom)),
    hasContent: left > 0 || right > 0 || top > 0 || bottom > 0,
  };
}

/**
 * Shrink the Canvas to exactly the content floor, discarding transparent margin
 * only. A Canvas already at its floor — or one with nothing drawn — is left as it
 * is.
 */
export async function fitCanvasToContent(
  root: string,
  options: CharacterScopedOptions,
): Promise<ResizeCanvasResult> {
  const floor = await contentFloor(root, options);
  if (!floor.hasContent) {
    const canvas = await readCanvas(root, options.characterId);
    return { canvas, rebakedClips: [], rebakedSequences: [], repairWarnings: [] };
  }
  return resizeCanvas(root, { ...options, width: floor.width, height: floor.height });
}

/** Read every Clip/Draft offset for a Character — the Alignment stage's view model. */
export async function readCharacterAlignment(
  root: string,
  options: CharacterScopedOptions,
): Promise<CharacterAlignment> {
  const { characterId } = options;
  assertValidId(characterId, 'character', 'characterId');
  const canvas = await readCanvas(root, characterId);
  const floor = await contentFloor(root, { characterId });

  const clips: CharacterAlignment['clips'] = [];
  for (const clipId of await listDirectories(root, clipsDir(characterId))) {
    const provenanceRel = assetProvenancePath(characterId, 'clip', clipId);
    if (!(await pathExists(root, provenanceRel))) {
      continue;
    }
    const provenance = (await readJsonFile(root, provenanceRel)) as {
      placementOffset?: PlacementOffset;
    };
    validateArtifact('clip-provenance', provenance, { artifact: provenanceRel });
    const meta = (await readJsonFile(root, assetMetaPath(characterId, 'clip', clipId))) as {
      frameCount: number;
    };
    clips.push({
      id: clipId,
      frameCount: meta.frameCount,
      ...(provenance.placementOffset ? { placementOffset: { ...provenance.placementOffset } } : {}),
    });
  }

  const drafts: CharacterAlignment['drafts'] = [];
  for (const draftId of await listDirectories(root, draftsDir(characterId))) {
    if (!(await pathExists(root, draftPath(characterId, draftId)))) {
      continue;
    }
    const draft = await readClipDraft(root, { characterId, draftId });
    drafts.push({
      id: draftId,
      ...(draft.placementOffset ? { placementOffset: { ...draft.placementOffset } } : {}),
    });
  }

  return { canvas, contentFloor: floor, clips, drafts };
}

// --- internals ----------------------------------------------------------------

/** Report whether an offset's recorded framing still matches the current one. */
function checkAlignmentValidity(
  authored: RepairFraming | undefined,
  framing: RepairFraming,
): AlignmentWarning[] {
  if (
    authored &&
    (authored.frameCount !== framing.frameCount ||
      authored.width !== framing.width ||
      authored.height !== framing.height)
  ) {
    return [
      {
        code: 'alignment-framing-changed',
        message:
          `The placement offset was chosen for ${authored.frameCount} frame(s) on a ` +
          `${authored.width}x${authored.height} Canvas, but the Clip is now ` +
          `${framing.frameCount} on ${framing.width}x${framing.height}; its placement may no longer suit.`,
      },
    ];
  }
  return [];
}

function framingOf(canvas: Canvas, frameCount: number): RepairFraming {
  return { frameCount, width: canvas.width, height: canvas.height };
}

/** Re-bake one committed Clip's strip: translate each frame by `(dx, dy)`. */
async function rebakeSheet(
  root: string,
  characterId: string,
  clipId: string,
  frameCount: number,
  old: Canvas,
  canvas: Canvas,
  dx: number,
  dy: number,
): Promise<void> {
  const sheetRel = sheetPath(characterId, 'clip', clipId);
  const { data, info } = await sharp(await readBinaryFile(root, sheetRel))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const expectedWidth = frameCount * old.width;
  if (info.width !== expectedWidth || info.height !== old.height) {
    throw new StoreError(
      `Committed Clip "${clipId}" sheet is ${info.width}x${info.height}; expected ` +
        `${expectedWidth}x${old.height} (frameCount × Canvas) before expanding.`,
    );
  }

  const sheetWidth = frameCount * canvas.width;
  const out = Buffer.alloc(sheetWidth * canvas.height * 4);
  for (let index = 0; index < frameCount; index++) {
    // The strip's rows are `info.width` wide, so lift each Canvas cell row by row.
    const frame: RgbaImage = {
      width: old.width,
      height: old.height,
      data: new Uint8Array(old.width * old.height * 4),
    };
    for (let y = 0; y < old.height; y++) {
      const from = (y * info.width + index * old.width) * 4;
      frame.data.set(data.subarray(from, from + old.width * 4), y * old.width * 4);
    }
    const placed = placeOnCanvas(frame, canvas.width, canvas.height, dx, dy);
    const offsetX = index * canvas.width;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const from = (y * canvas.width + x) * 4;
        const to = (y * sheetWidth + offsetX + x) * 4;
        out.set(placed.data.subarray(from, from + 4), to);
      }
    }
  }

  const png = await sharp(out, {
    raw: { width: sheetWidth, height: canvas.height, channels: 4 },
  })
    .png()
    .toBuffer();
  await writeBinaryFile(root, sheetRel, png);
}

/** Re-place one Draft's frames on the new Canvas (pure translation). */
async function replaceDraftFrames(
  root: string,
  characterId: string,
  draftId: string,
  old: Canvas,
  canvas: Canvas,
  dx: number,
  dy: number,
): Promise<void> {
  const draft = await readClipDraft(root, { characterId, draftId });
  for (let index = 0; index < draft.frameCount; index++) {
    const raw = await readBinaryFile(root, draft.frames[index]!);
    const { data, info } = await sharp(raw)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== old.width || info.height !== old.height) {
      // Already the new size (e.g. a second expand): leave it as it is.
      continue;
    }
    const placed = placeOnCanvas(
      { width: old.width, height: old.height, data: new Uint8Array(data) },
      canvas.width,
      canvas.height,
      dx,
      dy,
    );
    const png = await sharp(Buffer.from(placed.data), {
      raw: { width: canvas.width, height: canvas.height, channels: 4 },
    })
      .png()
      .toBuffer();
    await writeBinaryFile(root, draft.frames[index]!, png);
  }
}

/** Read and validate a committed Clip's meta (its `frameCount` is needed to re-bake). */
async function readClipMeta(
  root: string,
  characterId: string,
  clipId: string,
): Promise<{ frameCount: number }> {
  const metaRel = assetMetaPath(characterId, 'clip', clipId);
  if (!(await pathExists(root, metaRel))) {
    throw new StoreError(`Committed Clip "${clipId}" has no meta.json (${metaRel}).`);
  }
  const meta = await readJsonFile(root, metaRel);
  validateArtifact('asset-meta', meta, { artifact: metaRel, folderId: clipId });
  return meta as { frameCount: number };
}

/** Read and validate the Character's Canvas. */
async function readCanvas(root: string, characterId: string): Promise<Canvas> {
  const artifact = canvasPath(characterId);
  if (!(await pathExists(root, artifact))) {
    throw new StoreError(`No Character "${characterId}" in the store (${artifact} is missing).`);
  }
  const value = await readJsonFile(root, artifact);
  validateArtifact('canvas', value, { artifact });
  return value as Canvas;
}

function isZero(offset: PlacementOffset): boolean {
  return offset.x === 0 && offset.y === 0;
}

function assertOffset(offset: PlacementOffset): void {
  if (
    typeof offset !== 'object' ||
    offset === null ||
    !Number.isInteger(offset.x) ||
    !Number.isInteger(offset.y)
  ) {
    throw new StoreError('placementOffset must be an object with integer x and y.');
  }
}

