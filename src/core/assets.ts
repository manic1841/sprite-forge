/**
 * `assets` — commit a Draft into an immutable Asset, and fork an Asset.
 *
 * **Commit** promotes a Draft (editable working state) into a named, immutable
 * Asset (GLOSSARY.md): it bakes the Draft's frames into a `sheet.png` strip and
 * writes the contract artifacts beside it (format-spec §1, §5, §6). The stored
 * sheet is authoritative and re-running never replaces it (ADR-0004); editing an
 * Asset means **forking** it (ADR-0002).
 *
 * **Fork** opens a committed Asset as a new Draft. On commit, the new Asset's
 * provenance records its lineage (`derivedFrom`) and the original is kept.
 *
 * Frame size is **always** the Character's Canvas (Rule 3.2): a committed Asset
 * stores no width or height, and the sheet is `frameCount` canvas-sized frames
 * laid out left to right (docs/export-contract.md).
 */

import sharp from 'sharp';
import type { Canvas } from './character.js';
import {
  readClipDraft,
  writeClipDraft,
  type ClipDraft,
  type ClipDraftDescriptor,
  type DraftBackground,
  type DraftSegmentSnapshot,
} from './draft.js';
import { StoreError } from './errors.js';
import { translateOnCanvas } from './frames.js';
import { isValidId } from './ids.js';
import {
  assetDir,
  assetMetaPath,
  assetProvenancePath,
  canvasPath,
  clipDir,
  draftDir,
  draftFramePath,
  repairPath,
  sequenceDir,
  sheetPath,
} from './layout.js';
import {
  pathExists,
  readBinaryFile,
  readJsonFile,
  removePath,
  writeBinaryFile,
  writeJsonFile,
} from './store/index.js';
import type { AssetKind, AssetRef } from './types.js';
import { validateArtifact } from './validate.js';
import { SPRITE_FORGE_VERSION } from './version.js';
import {
  applyRepairScriptToFrame,
  copyRepairScript,
  readRepairScript,
  rehomeRepairScript,
  type RepairFraming,
  type RepairScript,
} from './repair.js';

/** The `meta.json` of a committed Clip or Sequence (format-spec §5). */
export interface AssetMeta {
  /** The Asset id; must equal the folder name. */
  id: string;
  /** Number of frames in the sheet. */
  frameCount: number;
  /** Per-frame delays in ms; one (uniform) or exactly `frameCount` values. */
  delaysMs: number[];
  /** Whether the Asset loops. */
  loop: boolean;
}

/** The `provenance.json` of a committed Clip (format-spec §6). */
export interface ClipProvenance {
  recordingId: string;
  recordingHash: string;
  /** A snapshot of the resolved cut at commit time (Rule 6.1). */
  segment: DraftSegmentSnapshot;
  background: DraftBackground;
  /** The Clip's Repair-script reference, relative to the store root; null when none. */
  repair: string | null;
  /** Manual placement on top of the automatic Anchor; omitted when `{0,0}`. */
  placementOffset?: { x: number; y: number };
  /** The forked-from Asset, or null. */
  derivedFrom: AssetRef | null;
  spriteForgeVersion: string;
}

/** A committed Asset as returned by {@link commitDraft}. */
export interface CommittedAsset {
  kind: AssetKind;
  id: string;
  /** Store-relative POSIX directory. */
  dir: string;
  meta: AssetMeta;
  provenance: ClipProvenance;
}

/** Inputs for {@link commitDraft}. */
export interface CommitDraftOptions {
  /** The Character that owns the Draft and the new Asset. */
  characterId: string;
  /** The Draft to promote. */
  draftId: string;
  /** The new Asset's id (its name); also the folder name. */
  assetId: string;
  /** The Asset kind; defaults to `clip`. Sequence commit is #29. */
  kind?: AssetKind;
}

/**
 * Commit a Draft into an immutable, named Asset.
 *
 * The new Asset id is validated and must not collide with any committed Asset of
 * the Character — Clip and Sequence ids share one namespace, and a committed
 * Asset is never overwritten. The Draft's frames are tiled into a `sheet.png`,
 * `meta.json` and `provenance.json` are written and validated, and the Draft is
 * removed last, so a failed commit leaves the Draft intact.
 */
export async function commitDraft(
  root: string,
  options: CommitDraftOptions,
): Promise<CommittedAsset> {
  const { characterId, draftId, assetId } = options;
  const kind = options.kind ?? 'clip';
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(draftId, 'draft', 'draftId');
  assertValidId(assetId, 'asset', 'assetId');
  assertKindImplemented(kind);

  const canvas = await readCanvas(root, characterId);
  const draft = await readClipDraft(root, { characterId, draftId });
  await assertIdFree(root, characterId, assetId);

  // Commit replays the Draft's Repair script and bakes the **repaired** frames.
  const script = await readRepairScript(root, { characterId, clipId: draftId });
  const sheet = await tileFrames(root, draft, canvas, script);
  // The Draft's script is re-homed onto the committed Asset id (the fork seam
  // #24 opened); provenance points at the re-homed script.
  const repairRel =
    script.operations.length > 0 || draft.repair ? repairPath(characterId, assetId) : null;
  if (script.operations.length > 0) {
    await rehomeRepairScript(root, characterId, draftId, assetId);
  }
  const meta: AssetMeta = {
    id: assetId,
    frameCount: draft.frameCount,
    delaysMs: [...draft.delaysMs],
    loop: draft.loop,
  };
  const provenance = buildClipProvenance(characterId, draft, repairRel);

  const metaRel = assetMetaPath(characterId, kind, assetId);
  const provenanceRel = assetProvenancePath(characterId, kind, assetId);
  validateArtifact('asset-meta', meta, { artifact: metaRel, folderId: assetId });
  validateArtifact('clip-provenance', provenance, { artifact: provenanceRel });

  await writeBinaryFile(root, sheetPath(characterId, kind, assetId), sheet);
  await writeJsonFile(root, metaRel, meta);
  await writeJsonFile(root, provenanceRel, provenance);

  // The Draft is removed only after the Asset is on disk.
  await removePath(root, draft.dir);

  return { kind, id: assetId, dir: assetDir(characterId, kind, assetId), meta, provenance };
}

/** Inputs for {@link forkAsset}. */
export interface ForkAssetOptions {
  /** The Character that owns the Asset and the new Draft. */
  characterId: string;
  /** Whether the existing Asset is a Clip or a Sequence. Required: ids are shared. */
  kind: AssetKind;
  /** The existing Asset to open. */
  id: string;
  /** The new Draft id; defaults to the parent Asset id. */
  draftId?: string;
}

/**
 * Fork an existing Asset: open it as a new Draft (ADR-0002).
 *
 * The committed Asset is read, validated and **sliced back** into canvas-sized
 * frames; its Segment, background, Recording, delays, loop, `placementOffset` and
 * Repair-script reference are inherited so the new branch starts from it. The
 * parent is never modified. On the following commit the new Asset records its
 * `derivedFrom` lineage.
 */
export async function forkAsset(root: string, options: ForkAssetOptions): Promise<ClipDraft> {
  const { characterId, kind, id } = options;
  const draftId = options.draftId ?? id;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(id, 'asset', 'id');
  assertValidId(draftId, 'draft', 'draftId');
  assertKindImplemented(kind);

  const canvas = await readCanvas(root, characterId);
  const parent = await readCommittedClip(root, characterId, id);
  const frames = await sliceSheet(root, characterId, id, parent.meta, canvas);

  // A committed sheet already carries the parent's manual placement offset; a
  // fork's Draft holds the **automatic** placement again (the offset is recorded
  // on the descriptor and re-applied on the next bake), so un-translate it here.
  const inheritedOffset = parent.provenance.placementOffset ?? { x: 0, y: 0 };

  await removePath(root, draftDir(characterId, draftId));
  const framePaths: string[] = [];
  for (let index = 0; index < frames.length; index++) {
    const automatic = translateOnCanvas(
      { width: canvas.width, height: canvas.height, data: frames[index]! },
      -inheritedOffset.x,
      -inheritedOffset.y,
    );
    const png = await sharp(Buffer.from(automatic.data), {
      raw: { width: canvas.width, height: canvas.height, channels: 4 },
    })
      .png()
      .toBuffer();
    const relPath = draftFramePath(characterId, draftId, index);
    await writeBinaryFile(root, relPath, png);
    framePaths.push(relPath);
  }

  const inheritedRepair = parent.provenance.repair;
  const descriptor: ClipDraftDescriptor = {
    id: draftId,
    characterId,
    recordingId: parent.provenance.recordingId,
    recordingHash: parent.provenance.recordingHash,
    segment: { ...parent.provenance.segment },
    background: { ...parent.provenance.background },
    frameCount: parent.meta.frameCount,
    delaysMs: expandDelays(parent.meta.delaysMs, parent.meta.frameCount),
    loop: parent.meta.loop,
    spriteForgeVersion: SPRITE_FORGE_VERSION,
    derivedFrom: { kind: 'clip', id },
    ...(hasOffset(inheritedOffset)
      ? {
          placementOffset: { ...inheritedOffset },
          placementFraming: {
            frameCount: parent.meta.frameCount,
            width: canvas.width,
            height: canvas.height,
          },
        }
      : {}),
    ...(inheritedRepair ? { repair: inheritedRepair } : {}),
  };

  // A fork copies the parent's Repair script so the new branch starts from it.
  if (inheritedRepair) {
    const copied = await copyRepairScript(root, characterId, id, draftId);
    if (copied) {
      descriptor.repairFraming = {
        frameCount: parent.meta.frameCount,
        width: canvas.width,
        height: canvas.height,
      };
    }
  }

  await writeClipDraft(root, descriptor);
  return { ...descriptor, dir: draftDir(characterId, draftId), frames: framePaths };
}

/** A committed Asset's baked strip, read as image bytes for a front end to display. */
export interface AssetSheet {
  /** Store-relative POSIX path of the sheet PNG. */
  path: string;
  /** The image media type the bytes carry. */
  contentType: 'image/png';
  /** The PNG bytes. */
  data: Buffer;
}

/** Inputs for {@link readAssetSheet}. */
export interface ReadAssetSheetOptions {
  characterId: string;
  /** Whether the Asset is a Clip or a Sequence. Required: ids are shared. */
  kind: AssetKind;
  id: string;
}

/**
 * Read a committed Asset's `sheet.png` as image bytes.
 *
 * A browser cannot read the store, so the Alignment stage's ghosted Clips are
 * served these bytes over the front end's own boundary. The Asset's folder is
 * checked first, so a missing Asset is a hard error rather than an empty image.
 */
export async function readAssetSheet(
  root: string,
  options: ReadAssetSheetOptions,
): Promise<AssetSheet> {
  const { characterId, kind, id } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(id, 'asset', 'id');
  const relPath = sheetPath(characterId, kind, id);
  if (!(await pathExists(root, relPath))) {
    throw new StoreError(
      `No committed ${kind} "${id}" for Character "${characterId}" (${relPath} is missing).`,
    );
  }
  return { path: relPath, contentType: 'image/png', data: await readBinaryFile(root, relPath) };
}

// --- internals ----------------------------------------------------------------

/** Is a placement offset non-zero? `{0,0}` is an absent offset (docs/alignment.md). */
function hasOffset(offset: { x: number; y: number }): boolean {
  return offset.x !== 0 || offset.y !== 0;
}

/** Build the committed Clip's provenance (format-spec §6) from a Draft. */
function buildClipProvenance(
  characterId: string,
  draft: ClipDraftDescriptor,
  repair: string | null,
): ClipProvenance {
  const provenance: ClipProvenance = {
    recordingId: draft.recordingId,
    recordingHash: draft.recordingHash,
    segment: { ...draft.segment },
    background: { ...draft.background },
    repair,
    derivedFrom: draft.derivedFrom ?? null,
    spriteForgeVersion: SPRITE_FORGE_VERSION,
  };
  const offset = draft.placementOffset;
  if (offset && (offset.x !== 0 || offset.y !== 0)) {
    provenance.placementOffset = { ...offset };
  }
  return provenance;
}

/**
 * The Repair-script reference a fork's committed Asset inherits.
 *
 * The **fork seam** for Repair (#27): a fork carries the parent's script
 * reference on its Draft, and commit re-homes it onto the new Clip id. When the
 * parent has no script this is a no-op (`null`). #27 materialises Repair scripts
 * and must additionally copy the script file to the returned path.
 */
export function inheritRepairReference(
  characterId: string,
  assetId: string,
  parentRepair: string | null | undefined,
): string | null {
  if (!parentRepair) {
    return null;
  }
  return repairPath(characterId, assetId);
}

/** Tile the Draft's canvas-sized frames left to right into one PNG strip. */
async function tileFrames(
  root: string,
  draft: ClipDraft,
  canvas: Canvas,
  script: RepairScript,
): Promise<Buffer> {
  const sheetWidth = draft.frameCount * canvas.width;
  const sheetHeight = canvas.height;
  const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4);

  // The manual placement offset is a pure translation on top of the automatic
  // Anchor placement (docs/alignment.md), re-applied here on every bake.
  const offset = draft.placementOffset ?? { x: 0, y: 0 };

  for (let index = 0; index < draft.frameCount; index++) {
    const decoded = await decodeCanvasFrame(root, draft.frames[index]!, canvas, draft.id);
    // Baked tiles are the repaired result: replay the script for this frame,
    // then place the Clip manually by its offset.
    const repaired = applyRepairScriptToFrame(
      { width: canvas.width, height: canvas.height, data: new Uint8Array(decoded) },
      index,
      script,
    );
    const frame = translateOnCanvas(repaired, offset.x, offset.y).data;
    const offsetX = index * canvas.width;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const from = (y * canvas.width + x) * 4;
        const to = (y * sheetWidth + offsetX + x) * 4;
        sheet.set(frame.subarray(from, from + 4), to);
      }
    }
  }

  return sharp(sheet, { raw: { width: sheetWidth, height: sheetHeight, channels: 4 } })
    .png()
    .toBuffer();
}

/** Decode a Draft frame and check it is exactly the Character's Canvas. */
async function decodeCanvasFrame(
  root: string,
  relPath: string,
  canvas: Canvas,
  draftId: string,
): Promise<Buffer> {
  const bytes = await readBinaryFile(root, relPath);
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== canvas.width || info.height !== canvas.height) {
    throw new StoreError(
      `Draft "${draftId}" frame ${relPath} is ${info.width}x${info.height}; ` +
        `expected the Character's Canvas ${canvas.width}x${canvas.height}.`,
    );
  }
  return data;
}

/** Read and validate a committed Clip's meta and provenance. */
async function readCommittedClip(
  root: string,
  characterId: string,
  clipId: string,
): Promise<{ meta: AssetMeta; provenance: ClipProvenance }> {
  const dir = clipDir(characterId, clipId);
  if (!(await pathExists(root, dir))) {
    throw new StoreError(
      `No committed Asset "${clipId}" for Character "${characterId}" (${dir} is missing).`,
    );
  }
  const metaRel = assetMetaPath(characterId, 'clip', clipId);
  const provenanceRel = assetProvenancePath(characterId, 'clip', clipId);
  if (!(await pathExists(root, metaRel))) {
    throw new StoreError(`Committed Clip "${clipId}" has no meta.json (${metaRel}).`);
  }
  if (!(await pathExists(root, provenanceRel))) {
    throw new StoreError(`Committed Clip "${clipId}" has no provenance.json (${provenanceRel}).`);
  }
  const meta = await readJsonFile(root, metaRel);
  validateArtifact('asset-meta', meta, { artifact: metaRel, folderId: clipId });
  const provenance = await readJsonFile(root, provenanceRel);
  validateArtifact('clip-provenance', provenance, { artifact: provenanceRel });
  return { meta: meta as AssetMeta, provenance: provenance as ClipProvenance };
}

/** Slice a committed Clip's strip back into `frameCount` canvas-sized frames. */
async function sliceSheet(
  root: string,
  characterId: string,
  clipId: string,
  meta: AssetMeta,
  canvas: Canvas,
): Promise<Buffer[]> {
  const sheetRel = sheetPath(characterId, 'clip', clipId);
  if (!(await pathExists(root, sheetRel))) {
    throw new StoreError(`Committed Clip "${clipId}" has no sheet.png (${sheetRel}).`);
  }
  const bytes = await readBinaryFile(root, sheetRel);
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const expectedWidth = meta.frameCount * canvas.width;
  if (info.width !== expectedWidth || info.height !== canvas.height) {
    throw new StoreError(
      `Committed Clip "${clipId}" sheet is ${info.width}x${info.height}; expected ` +
        `${expectedWidth}x${canvas.height} (frameCount × Canvas).`,
    );
  }

  const frames: Buffer[] = [];
  for (let index = 0; index < meta.frameCount; index++) {
    const frame = Buffer.alloc(canvas.width * canvas.height * 4);
    const offsetX = index * canvas.width;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const from = (y * info.width + offsetX + x) * 4;
        const to = (y * canvas.width + x) * 4;
        frame.set(data.subarray(from, from + 4), to);
      }
    }
    frames.push(frame);
  }
  return frames;
}

/** Expand a uniform `delaysMs` to one value per frame; pass a per-frame list through. */
function expandDelays(delaysMs: number[], frameCount: number): number[] {
  if (delaysMs.length === 1) {
    return Array.from({ length: frameCount }, () => delaysMs[0]!);
  }
  return [...delaysMs];
}

/** Refuse a commit whose id is already taken by a committed Clip or Sequence. */
async function assertIdFree(root: string, characterId: string, assetId: string): Promise<void> {
  const existingClip = clipDir(characterId, assetId);
  if (await pathExists(root, existingClip)) {
    throw new StoreError(
      `Asset "${assetId}" already exists for Character "${characterId}" (${existingClip}); ` +
        `a committed Asset is immutable — fork it to make a variant.`,
    );
  }
  const existingSequence = sequenceDir(characterId, assetId);
  if (await pathExists(root, existingSequence)) {
    throw new StoreError(
      `Asset id "${assetId}" is already a committed Sequence for Character ` +
        `"${characterId}" (${existingSequence}); Clip and Sequence ids share one namespace.`,
    );
  }
}

/** Sequence commit/fork is in scope conceptually but tracked by ticket #29. */
function assertKindImplemented(kind: AssetKind): void {
  if (kind !== 'clip') {
    throw new StoreError(
      `Committing or forking a ${kind} is not implemented yet; Sequence work is tracked by ticket #29.`,
    );
  }
}

/** Read and validate the Character's Canvas; its frame size is the Asset's too. */
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

/** Reject an id that does not match the id grammar before it becomes a path segment. */
function assertValidId(id: string, noun: string, label: string): void {
  if (!isValidId(id)) {
    throw new StoreError(`Invalid ${label} "${id}" (${noun} id): must match /^[a-z][a-z0-9-]*$/.`);
  }
}
