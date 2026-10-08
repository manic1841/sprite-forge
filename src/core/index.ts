/**
 * The core command surface.
 *
 * Front ends (CLI, web) call these; core never imports UI or HTTP types. The
 * filesystem lives behind `./store/` only.
 */

export { scan, readStoreTree } from './scan.js';
export type { CharacterTree, StoreTree } from './scan.js';

export { ingestRecording } from './ingest.js';
export type { IngestRecordingOptions, IngestedRecording } from './ingest.js';

export { createCharacter } from './character.js';
export type {
  Canvas,
  CanvasAnchor,
  CreateCharacterOptions,
  CreatedCharacter,
} from './character.js';

export { addSegment, readCutList, removeSegment, renameSegment } from './segments.js';
export type {
  AddSegmentOptions,
  CutList,
  RemoveSegmentOptions,
  RenameSegmentOptions,
  Segment,
} from './segments.js';

export { extractClipDraft, readClipDraft } from './draft.js';
export type {
  ClipDraft,
  ClipDraftDescriptor,
  DraftBackground,
  DraftSegmentSnapshot,
  ExtractClipDraftOptions,
  ReadClipDraftOptions,
} from './draft.js';

export { ID_PATTERN, isValidId } from './ids.js';

export { validateArtifact, validateStore } from './validate.js';
export type {
  ArtifactContext,
  ArtifactKind,
  StoreValidationReport,
  ValidatedArtifact,
} from './validate.js';

export { ForgeError, StoreError, ValidationError } from './errors.js';
export type { ValidationIssue } from './errors.js';

export type {
  AssetKind,
  ScannedAsset,
  ScannedCharacter,
  ScannedExport,
  ScannedRecording,
  StoreScan,
} from './types.js';
