/**
 * The store's on-disk layout, in one place.
 *
 * These helpers return **store-relative POSIX paths**. Keeping the shape here
 * means `scan`, `validate` and the CLI never hard-code directory names twice.
 * See `docs/format-spec.md` §1 for the layout this mirrors.
 */

export const RECORDINGS_DIR = 'recordings';
export const CHARACTERS_DIR = 'characters';
export const EXPORTS_DIR = 'exports';

export function recordingDir(recordingId: string): string {
  return `${RECORDINGS_DIR}/${recordingId}`;
}

export function cutsPath(recordingId: string): string {
  return `${recordingDir(recordingId)}/cuts.json`;
}

export function sourcePath(recordingId: string): string {
  return `${recordingDir(recordingId)}/source.gif`;
}

export function characterDir(characterId: string): string {
  return `${CHARACTERS_DIR}/${characterId}`;
}

export function canvasPath(characterId: string): string {
  return `${characterDir(characterId)}/canvas.json`;
}

export function clipsDir(characterId: string): string {
  return `${characterDir(characterId)}/clips`;
}

export function clipDir(characterId: string, clipId: string): string {
  return `${clipsDir(characterId)}/${clipId}`;
}

export function sequencesDir(characterId: string): string {
  return `${characterDir(characterId)}/sequences`;
}

export function sequenceDir(characterId: string, sequenceId: string): string {
  return `${sequencesDir(characterId)}/${sequenceId}`;
}

/** The folder of a committed Asset; a Clip and a Sequence pick different parents. */
export function assetDir(
  characterId: string,
  kind: 'clip' | 'sequence',
  assetId: string,
): string {
  return kind === 'clip' ? clipDir(characterId, assetId) : sequenceDir(characterId, assetId);
}

/** The baked strip of a committed Asset (`sheet.png`). */
export function sheetPath(
  characterId: string,
  kind: 'clip' | 'sequence',
  assetId: string,
): string {
  return `${assetDir(characterId, kind, assetId)}/${ASSET_SHEET_FILE}`;
}

/** The `meta.json` of a committed Asset. */
export function assetMetaPath(
  characterId: string,
  kind: 'clip' | 'sequence',
  assetId: string,
): string {
  return `${assetDir(characterId, kind, assetId)}/${ASSET_META_FILE}`;
}

/** The `provenance.json` of a committed Asset. */
export function assetProvenancePath(
  characterId: string,
  kind: 'clip' | 'sequence',
  assetId: string,
): string {
  return `${assetDir(characterId, kind, assetId)}/${ASSET_PROVENANCE_FILE}`;
}

export function draftsDir(characterId: string): string {
  return `${characterDir(characterId)}/drafts`;
}

export function draftDir(characterId: string, draftId: string): string {
  return `${draftsDir(characterId)}/${draftId}`;
}

/** The Draft's descriptor (`draft.json`); an implementation detail, not frozen (format-spec §11). */
export function draftPath(characterId: string, draftId: string): string {
  return `${draftDir(characterId, draftId)}/draft.json`;
}

export function draftFramesDir(characterId: string, draftId: string): string {
  return `${draftDir(characterId, draftId)}/frames`;
}

/** The zero-padded PNG file name for frame `index` within a Draft. */
export function draftFrameFileName(index: number): string {
  return `${String(index).padStart(3, '0')}.png`;
}

export function draftFramePath(characterId: string, draftId: string, index: number): string {
  return `${draftFramesDir(characterId, draftId)}/${draftFrameFileName(index)}`;
}

export function repairsDir(characterId: string): string {
  return `${characterDir(characterId)}/repairs`;
}

/**
 * Sequence drafts: a Short composition recipe (its ordered Clip ids), kept apart
 * from the frame Drafts under `drafts/` so the two never collide in one scan.
 */
export function sequenceDraftsDir(characterId: string): string {
  return `${characterDir(characterId)}/sequence-drafts`;
}

export function sequenceDraftDir(characterId: string, draftId: string): string {
  return `${sequenceDraftsDir(characterId)}/${draftId}`;
}

/** A Sequence draft's recipe (`draft.json`); design-local, not a frozen format. */
export function sequenceDraftPath(characterId: string, draftId: string): string {
  return `${sequenceDraftDir(characterId, draftId)}/draft.json`;
}

export function repairPath(characterId: string, clipId: string): string {
  return `${repairsDir(characterId)}/${clipId}/repair.json`;
}

export function exportDir(target: string): string {
  return `${EXPORTS_DIR}/${target}`;
}

export function manifestPath(target: string): string {
  return `${exportDir(target)}/manifest.json`;
}

/** The one folder of copied sheets inside an Export (`exports/<target>/clips/`). */
export function exportClipsDir(target: string): string {
  return `${exportDir(target)}/clips`;
}

/** A copied Asset sheet inside an Export, named by the exported Asset id. */
export function exportSheetPath(target: string, assetId: string): string {
  return `${exportClipsDir(target)}/${assetId}.png`;
}

/** The contract artifacts every committed Asset folder holds, in read order. */
export const ASSET_META_FILE = 'meta.json';
export const ASSET_PROVENANCE_FILE = 'provenance.json';
export const ASSET_SHEET_FILE = 'sheet.png';
