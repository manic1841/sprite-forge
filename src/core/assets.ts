/**
 * `assets` — commit Assets (a Draft into a Clip, or Clips into a Sequence), read
 * them back, and fork them.
 *
 * **Commit** promotes editable working state into a named, immutable Asset
 * (GLOSSARY.md): a **Clip** is baked from a Draft's frames, a **Sequence** is
 * concatenated from an ordered list of committed Clips. Either way the baked
 * `sheet.png` is authoritative and re-running never replaces it (ADR-0004);
 * editing an Asset means **forking** it (ADR-0002).
 *
 * **Fork** opens a committed Asset as a new Draft (a Clip) or as its ordered Clip
 * list (a Sequence). On commit, the new Asset's provenance records its lineage
 * (`derivedFrom`) and the original is kept.
 *
 * Frame size is **always** the Character's Canvas (Rule 3.2): a committed Asset
 * stores no width or height, and the sheet is `frameCount` canvas-sized frames
 * laid out left to right (docs/export-contract.md).
 */

import sharp from 'sharp';
import type { RgbaImage } from './background.js';
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
import { assertValidId } from './ids.js';
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
  sequencesDir,
  sheetPath,
} from './layout.js';
import {
  listDirectories,
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
  /**
   * The Asset kind a Draft commits to. A Draft bakes into a **Clip**; a Sequence
   * is committed from an ordered Clip list via {@link commitSequence}. Passing
   * `sequence` is a hard error that names the right verb.
   */
  kind?: AssetKind;
}

/** The `provenance.json` of a committed Sequence (format-spec §7). */
export interface SequenceProvenance {
  /** The ordered source Clip ids, concatenated end to end. */
  clips: string[];
  /** The forked-from Asset, or null. */
  derivedFrom: AssetRef | null;
  spriteForgeVersion: string;
}

/** A committed Sequence as returned by {@link commitSequence}. */
export interface CommittedSequence {
  kind: 'sequence';
  id: string;
  /** Store-relative POSIX directory. */
  dir: string;
  meta: AssetMeta;
  provenance: SequenceProvenance;
}

/** Inputs for {@link commitSequence}. */
export interface CommitSequenceOptions {
  /** The Character that owns the source Clips and the new Sequence. */
  characterId: string;
  /** The new Sequence's id (its name); also the folder name. */
  sequenceId: string;
  /**
   * The **ordered** source Clip ids, concatenated end to end (Rule 7.1). There is
   * no per-clip offset and no repeat count — a Clip that plays twice is listed twice.
   */
  clips: string[];
  /** The forked-from Asset to record (`derivedFrom`); omitted means `null`. */
  derivedFrom?: AssetRef;
}

/**
 * The editable state a Sequence fork yields: the parent's ordered Clip list,
 * which a front end edits and re-concatenates by calling {@link commitSequence}
 * with this {@link SequenceFork.derivedFrom} (ADR-0002). A Sequence has no frame
 * Draft — its recipe *is* the ordered Clip list (Rule 7.2).
 */
export interface SequenceFork {
  kind: 'sequence';
  /** The forked-from Sequence id. */
  id: string;
  /** The parent's ordered source Clip ids, to edit and re-concatenate. */
  clips: string[];
  /** The lineage to record on the next commit. */
  derivedFrom: AssetRef;
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
  assertDraftKind(kind);

  const canvas = await readCanvas(root, characterId);
  const draft = await readClipDraft(root, { characterId, draftId });
  await assertIdFree(root, characterId, assetId);

  // Commit replays the Draft's Repair script and bakes the **repaired** frames.
  const script = await readRepairScript(root, { characterId, clipId: draftId });
  const sheet = await tileRepairedFrames(
    await decodeDraftFrames(root, draft, canvas),
    canvas,
    script,
    draft.placementOffset ?? { x: 0, y: 0 },
  );
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

/**
 * Commit a Sequence: concatenate an ordered list of committed Clips into one
 * immutable Asset (format-spec §7, GLOSSARY *Sequence*).
 *
 * A Sequence is **pure concatenation** (Rule 7.1): the Clips play back to back in
 * the order listed, with no per-clip offset and no repeat count. Its `sheet.png`
 * is the source Clips' strips tiled end to end, its `meta.json` is the sum of
 * their frame counts with their per-frame delays concatenated, and its
 * `provenance.json` lists the source Clip ids in order. Ids are shared with Clips,
 * so an id held by either kind is refused; a committed Sequence is immutable.
 */
export async function commitSequence(
  root: string,
  options: CommitSequenceOptions,
): Promise<CommittedSequence> {
  const { characterId, sequenceId, clips, derivedFrom } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(sequenceId, 'asset', 'sequenceId');
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new StoreError('A Sequence needs at least one source Clip id.');
  }
  for (const clipId of clips) {
    assertValidId(clipId, 'clip', 'a source clip id');
  }

  const canvas = await readCanvas(root, characterId);
  await assertIdFree(root, characterId, sequenceId);

  // Read each source Clip in order: missing or non-Clip ids are hard errors.
  const sources: Array<{ id: string; meta: AssetMeta }> = [];
  for (const clipId of clips) {
    const clip = await readCommittedClip(root, characterId, clipId);
    sources.push({ id: clipId, meta: clip.meta });
  }

  const meta = deriveSequenceMeta(sequenceId, sources.map((source) => source.meta));
  const provenance: SequenceProvenance = {
    clips: [...clips],
    derivedFrom: derivedFrom ?? null,
    spriteForgeVersion: SPRITE_FORGE_VERSION,
  };
  const sheet = await concatenateClipSheets(root, characterId, sources, canvas);

  const metaRel = assetMetaPath(characterId, 'sequence', sequenceId);
  const provenanceRel = assetProvenancePath(characterId, 'sequence', sequenceId);
  validateArtifact('asset-meta', meta, { artifact: metaRel, folderId: sequenceId });
  validateArtifact('sequence-provenance', provenance, { artifact: provenanceRel });

  await writeBinaryFile(root, sheetPath(characterId, 'sequence', sequenceId), sheet);
  await writeJsonFile(root, metaRel, meta);
  await writeJsonFile(root, provenanceRel, provenance);

  return {
    kind: 'sequence',
    id: sequenceId,
    dir: assetDir(characterId, 'sequence', sequenceId),
    meta,
    provenance,
  };
}

/**
 * Read a committed Sequence: its validated meta and provenance, plus the ordered
 * Clip ids. Broken provenance (a schema or contract violation) is a hard error.
 */
export async function readSequence(
  root: string,
  options: { characterId: string; sequenceId: string },
): Promise<CommittedSequence> {
  const { characterId, sequenceId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(sequenceId, 'asset', 'sequenceId');
  const { meta, provenance } = await readCommittedSequence(root, characterId, sequenceId);
  return {
    kind: 'sequence',
    id: sequenceId,
    dir: assetDir(characterId, 'sequence', sequenceId),
    meta,
    provenance,
  };
}

/**
 * Read a committed Clip: its validated meta and provenance. Broken provenance (a
 * schema or contract violation) is a hard error.
 */
export async function readClip(
  root: string,
  options: { characterId: string; clipId: string },
): Promise<CommittedAsset> {
  const { characterId, clipId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(clipId, 'asset', 'clipId');
  const { meta, provenance } = await readCommittedClip(root, characterId, clipId);
  return {
    kind: 'clip',
    id: clipId,
    dir: assetDir(characterId, 'clip', clipId),
    meta,
    provenance,
  };
}

/** A Sequence's baked strip rendered (but not written) from its provenance. */
export interface RenderedSequenceSheet {
  /** The concatenated strip bytes. */
  sheet: Buffer;
  /** The validated source Clips, in provenance order. */
  sources: Array<{ id: string; meta: AssetMeta }>;
  /** The Sequence's meta derived from its source Clips (Rule 7.1). */
  meta: AssetMeta;
}

/**
 * Re-concatenate a committed Sequence's strip from its provenance **without
 * writing it**. Clips are immutable, so this is deterministic; `verifyReproducible`
 * compares the result to the stored sheet, and {@link rebakeSequenceSheet} writes it.
 */
export async function renderSequenceSheet(
  root: string,
  options: { characterId: string; sequenceId: string; canvas?: Canvas },
): Promise<RenderedSequenceSheet> {
  const { characterId, sequenceId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(sequenceId, 'asset', 'sequenceId');
  // A caller mid-expand passes the new Canvas before it is written to disk.
  const canvas = options.canvas ?? (await readCanvas(root, characterId));
  const { provenance } = await readCommittedSequence(root, characterId, sequenceId);

  const sources: Array<{ id: string; meta: AssetMeta }> = [];
  for (const clipId of provenance.clips) {
    const clip = await readCommittedClip(root, characterId, clipId);
    sources.push({ id: clipId, meta: clip.meta });
  }
  const sheet = await concatenateClipSheets(root, characterId, sources, canvas);
  return { sheet, sources, meta: deriveSequenceMeta(sequenceId, sources.map((s) => s.meta)) };
}

/**
 * Regenerate a committed Sequence's `sheet.png` from its provenance (Rule 7.2).
 *
 * Clips are immutable, so the concatenation is deterministic; this is used by the
 * explicit expand-canvas re-bake (ADR-0006) to re-place a Sequence's frames after
 * the Character's Canvas has grown. `meta.json` and `provenance.json` are
 * unchanged — only the pixels move.
 */
export async function rebakeSequenceSheet(
  root: string,
  options: { characterId: string; sequenceId: string; canvas?: Canvas },
): Promise<void> {
  const { characterId, sequenceId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(sequenceId, 'asset', 'sequenceId');
  const { sheet } = await renderSequenceSheet(root, options);
  await writeBinaryFile(root, sheetPath(characterId, 'sequence', sequenceId), sheet);
}

/**
 * Fork a Sequence: yield its ordered Clip list to edit and re-concatenate.
 *
 * A Sequence has no frame Draft — its recipe is the ordered Clip list (Rule 7.2)
 * — so forking yields that list plus the lineage to record. Re-commit the edited
 * list with {@link commitSequence}, passing `derivedFrom` as `{kind:"sequence", id}`;
 * the parent is never modified.
 */
export async function forkSequence(
  root: string,
  options: { characterId: string; id: string },
): Promise<SequenceFork> {
  const { characterId, id } = options;
  const parent = await readSequence(root, { characterId, sequenceId: id });
  return {
    kind: 'sequence',
    id,
    clips: [...parent.provenance.clips],
    derivedFrom: { kind: 'sequence', id },
  };
}

/** Inputs for {@link forkAsset}. */
export interface ForkAssetOptions {
  /** The Character that owns the Asset and the fork. */
  characterId: string;
  /** Whether the existing Asset is a Clip or a Sequence. Required: ids are shared. */
  kind: AssetKind;
  /** The existing Asset to open. */
  id: string;
  /** The new Draft id for a Clip fork; defaults to the parent Asset id. */
  draftId?: string;
}

/**
 * Fork an existing Asset: open it as a new Draft (ADR-0002).
 *
 * A **Clip** is read, validated and **sliced back** into canvas-sized frames; its
 * Segment, background, Recording, delays, loop, `placementOffset` and
 * Repair-script reference are inherited so the new branch starts from it. A
 * **Sequence** has no frame Draft, so its fork yields the ordered Clip list to
 * edit and re-concatenate ({@link SequenceFork}). The parent is never modified. On
 * the following commit the new Asset records its `derivedFrom` lineage.
 */
export function forkAsset(
  root: string,
  options: ForkAssetOptions & { kind: 'clip' },
): Promise<ClipDraft>;
export function forkAsset(
  root: string,
  options: ForkAssetOptions & { kind: 'sequence' },
): Promise<SequenceFork>;
export async function forkAsset(
  root: string,
  options: ForkAssetOptions,
): Promise<ClipDraft | SequenceFork> {
  const { characterId, kind, id } = options;
  const draftId = options.draftId ?? id;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(id, 'asset', 'id');
  assertValidId(draftId, 'draft', 'draftId');

  if (kind === 'sequence') {
    return forkSequence(root, { characterId, id });
  }

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
    segment: {
      ...parent.provenance.segment,
      ...(parent.provenance.segment.rect === undefined
        ? {}
        : { rect: { ...parent.provenance.segment.rect } }),
    },
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

/**
 * Discard a Draft: delete its folder and any Repair script it owns.
 *
 * A Draft is working data, so dropping it loses no committed Asset. Nothing else
 * refers to a Draft id, so there is no referential check to make.
 */
export async function discardDraft(
  root: string,
  options: { characterId: string; draftId: string },
): Promise<void> {
  const { characterId, draftId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(draftId, 'draft', 'draftId');
  const rel = draftDir(characterId, draftId);
  if (!(await pathExists(root, rel))) {
    throw new StoreError(
      `No Draft "${draftId}" for Character "${characterId}" (${rel} is missing).`,
    );
  }
  await removePath(root, rel);
  await removePath(root, repairPath(characterId, draftId));
}

/** Inputs for {@link deleteAsset}. */
export interface DeleteAssetOptions {
  characterId: string;
  /** Whether the Asset is a Clip or a Sequence. Required: ids are shared. */
  kind: AssetKind;
  id: string;
}

/**
 * Delete a committed Asset.
 *
 * Unlike a Draft, a committed Asset can be referenced: a Sequence names its
 * source Clips in `provenance.json`. Deleting a Clip that a Sequence still uses
 * would leave that Sequence unbuildable, so it is refused and the holders are
 * listed — the caller deletes the Sequence first.
 */
export async function deleteAsset(root: string, options: DeleteAssetOptions): Promise<void> {
  const { characterId, kind, id } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(id, 'asset', 'id');

  const rel = assetDir(characterId, kind, id);
  if (!(await pathExists(root, rel))) {
    throw new StoreError(
      `No committed ${kind} "${id}" for Character "${characterId}" (${rel} is missing).`,
    );
  }

  if (kind === 'clip') {
    const holders: string[] = [];
    for (const sequenceId of await listDirectories(root, sequencesDir(characterId))) {
      const sequence = await readSequence(root, { characterId, sequenceId });
      if (sequence.provenance.clips.includes(id)) {
        holders.push(sequenceId);
      }
    }
    if (holders.length > 0) {
      throw new StoreError(
        `Clip "${id}" is used by Sequence(s) ${holders.join(', ')}; delete them first.`,
      );
    }
    // A Clip's Repair script is filed under the Clip id, so it goes with it.
    await removePath(root, repairPath(characterId, id));
  }

  await removePath(root, rel);
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
    segment: {
      ...draft.segment,
      ...(draft.segment.rect === undefined ? {} : { rect: { ...draft.segment.rect } }),
    },
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

/**
 * Tile canvas-sized frames left to right into one PNG strip, replaying the Repair
 * script and applying the manual placement offset per frame.
 *
 * This is the **bake** shared by commit (from a Draft's stored frames) and
 * `verifyReproducible` (from frames re-rendered out of provenance): same inputs,
 * same bytes. It is pure over in-memory data — it only encodes a PNG.
 */
export async function tileRepairedFrames(
  frames: readonly RgbaImage[],
  canvas: Canvas,
  script: RepairScript,
  offset: { x: number; y: number },
): Promise<Buffer> {
  const sheetWidth = frames.length * canvas.width;
  const sheetHeight = canvas.height;
  const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4);

  for (let index = 0; index < frames.length; index++) {
    // Baked tiles are the repaired result: replay the script for this frame,
    // then place the Clip manually by its offset.
    const repaired = applyRepairScriptToFrame(frames[index]!, index, script);
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

/** Decode a Draft's stored frames to canvas-sized RGBA images for {@link tileRepairedFrames}. */
async function decodeDraftFrames(
  root: string,
  draft: ClipDraft,
  canvas: Canvas,
): Promise<RgbaImage[]> {
  const frames: RgbaImage[] = [];
  for (let index = 0; index < draft.frameCount; index++) {
    const data = await decodeCanvasFrame(root, draft.frames[index]!, canvas, draft.id);
    frames.push({ width: canvas.width, height: canvas.height, data: new Uint8Array(data) });
  }
  return frames;
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
export async function readCommittedClip(
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
        `a committed Asset is immutable — fork it to make a new Asset.`,
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

/** A Draft bakes into a Clip; a Sequence is built from Clips, not a Draft. */
function assertDraftKind(kind: AssetKind): void {
  if (kind !== 'clip') {
    throw new StoreError(
      `A Draft commits into a Clip; to commit a Sequence, pass its ordered Clip ids to ` +
        `commitSequence (a Sequence has no frame Draft).`,
    );
  }
}

/** Derive a Sequence's meta (§5) from its source Clips: sum frames, concat delays. */
function deriveSequenceMeta(id: string, clipMetas: AssetMeta[]): AssetMeta {
  const frameCount = clipMetas.reduce((total, meta) => total + meta.frameCount, 0);
  // Each source's per-frame delays (expanding a uniform-1 value first, Rule 5.1),
  // concatenated, so the result is exactly frameCount long.
  const delaysMs = clipMetas.flatMap((meta) => expandDelays(meta.delaysMs, meta.frameCount));
  const uniform = delaysMs.every((delay) => delay === delaysMs[0]);
  return { id, frameCount, delaysMs: uniform ? [delaysMs[0]!] : delaysMs, loop: true };
}

/** Tile the source Clips' baked strips end to end into one canvas-tall PNG strip. */
async function concatenateClipSheets(
  root: string,
  characterId: string,
  sources: Array<{ id: string; meta: AssetMeta }>,
  canvas: Canvas,
): Promise<Buffer> {
  const totalFrames = sources.reduce((total, source) => total + source.meta.frameCount, 0);
  const sheetWidth = totalFrames * canvas.width;
  const out = Buffer.alloc(sheetWidth * canvas.height * 4);
  let frameOffset = 0;
  for (const source of sources) {
    const sheetRel = sheetPath(characterId, 'clip', source.id);
    if (!(await pathExists(root, sheetRel))) {
      throw new StoreError(`Source Clip "${source.id}" has no sheet.png (${sheetRel}).`);
    }
    const { data, info } = await sharp(await readBinaryFile(root, sheetRel))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const expectedWidth = source.meta.frameCount * canvas.width;
    if (info.width !== expectedWidth || info.height !== canvas.height) {
      throw new StoreError(
        `Source Clip "${source.id}" sheet is ${info.width}x${info.height}; expected ` +
          `${expectedWidth}x${canvas.height} (frameCount × Canvas).`,
      );
    }
    const offsetX = frameOffset * canvas.width;
    for (let y = 0; y < canvas.height; y++) {
      const from = y * info.width * 4;
      const to = (y * sheetWidth + offsetX) * 4;
      out.set(data.subarray(from, from + info.width * 4), to);
    }
    frameOffset += source.meta.frameCount;
  }
  return sharp(out, { raw: { width: sheetWidth, height: canvas.height, channels: 4 } })
    .png()
    .toBuffer();
}

/** Read and validate a committed Sequence's meta and provenance. */
async function readCommittedSequence(
  root: string,
  characterId: string,
  sequenceId: string,
): Promise<{ meta: AssetMeta; provenance: SequenceProvenance }> {
  const dir = sequenceDir(characterId, sequenceId);
  if (!(await pathExists(root, dir))) {
    throw new StoreError(
      `No committed Sequence "${sequenceId}" for Character "${characterId}" (${dir} is missing).`,
    );
  }
  const metaRel = assetMetaPath(characterId, 'sequence', sequenceId);
  const provenanceRel = assetProvenancePath(characterId, 'sequence', sequenceId);
  if (!(await pathExists(root, metaRel))) {
    throw new StoreError(`Committed Sequence "${sequenceId}" has no meta.json (${metaRel}).`);
  }
  if (!(await pathExists(root, provenanceRel))) {
    throw new StoreError(
      `Committed Sequence "${sequenceId}" has no provenance.json (${provenanceRel}).`,
    );
  }
  const meta = await readJsonFile(root, metaRel);
  validateArtifact('asset-meta', meta, { artifact: metaRel, folderId: sequenceId });
  const provenance = await readJsonFile(root, provenanceRel);
  validateArtifact('sequence-provenance', provenance, { artifact: provenanceRel });
  return { meta: meta as AssetMeta, provenance: provenance as SequenceProvenance };
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

