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

export { addSegment, readCutList, removeSegment, renameSegment, setSegmentRange } from './segments.js';
export type {
  AddSegmentOptions,
  CutList,
  RemoveSegmentOptions,
  RenameSegmentOptions,
  Segment,
  SetSegmentRangeOptions,
} from './segments.js';

export { extractClipDraft, readClipDraft, readClipDraftFrame } from './draft.js';
export type {
  ClipDraft,
  ClipDraftDescriptor,
  ClipDraftFrame,
  DraftBackground,
  DraftSegmentSnapshot,
  ExtractClipDraftOptions,
  ReadClipDraftFrameOptions,
  ReadClipDraftOptions,
} from './draft.js';

export { commitDraft, forkAsset, inheritRepairReference } from './assets.js';
export type {
  AssetMeta,
  ClipProvenance,
  CommittedAsset,
  CommitDraftOptions,
  ForkAssetOptions,
} from './assets.js';

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
  AssetRef,
  ScannedAsset,
  ScannedCharacter,
  ScannedDraft,
  ScannedExport,
  ScannedRecording,
  StoreScan,
} from './types.js';
