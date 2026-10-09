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

export { extractClipDraft, readClipDraft, readClipDraftFrame, renderSegmentFrames, deriveAnchor } from './draft.js';
export type {
  ClipDraft,
  ClipDraftDescriptor,
  ClipDraftFrame,
  DeriveAnchorOptions,
  DerivedAnchor,
  DraftBackground,
  DraftSegmentSnapshot,
  ExtractClipDraftOptions,
  ReadClipDraftFrameOptions,
  ReadClipDraftOptions,
  RenderedSegment,
  RenderSegmentFramesOptions,
} from './draft.js';

export {
  commitDraft,
  commitSequence,
  forkAsset,
  forkSequence,
  inheritRepairReference,
  readAssetSheet,
  readClip,
  readSequence,
  rebakeSequenceSheet,
  renderSequenceSheet,
  tileRepairedFrames,
} from './assets.js';
export type {
  AssetMeta,
  AssetSheet,
  ClipProvenance,
  CommittedAsset,
  CommittedSequence,
  CommitDraftOptions,
  CommitSequenceOptions,
  ForkAssetOptions,
  ReadAssetSheetOptions,
  RenderedSequenceSheet,
  SequenceFork,
  SequenceProvenance,
} from './assets.js';

export {
  expandCanvas,
  readCharacterAlignment,
  readDraftAlignment,
  setPlacementOffset,
} from './alignment.js';
export type {
  AlignmentState,
  AlignmentWarning,
  AlignmentWarningCode,
  CharacterAlignment,
  CharacterScopedOptions,
  ExpandCanvasOptions,
  ExpandCanvasResult,
  PlacementOffset,
  ReadDraftAlignmentOptions,
  SetPlacementOffsetOptions,
} from './alignment.js';

export {
  appendRepairOperation,
  applyRepairScript,
  applyRepairScriptToFrame,
  checkRepairValidity,
  copyRepairScript,
  readDraftRepair,
  readDraftRepairFrame,
  readRepairScript,
  rehomeRepairScript,
  sampleDraftRepairColor,
  samplePixelColor,
  undoRepairOperation,
  writeRepairScript,
} from './repair.js';
export type {
  AppendRepairOptions,
  DraftRepairOptions,
  FrameRange,
  ReadDraftRepairFrameOptions,
  RectGeometry,
  RepairClipOptions,
  RepairFraming,
  RepairOperation,
  RepairOperationInput,
  RepairScript,
  RepairState,
  RepairTool,
  RepairWarning,
  RepairWarningCode,
  SampleDraftRepairColorOptions,
  StrokeGeometry,
} from './repair.js';

export { ID_PATTERN, isValidId } from './ids.js';

export { EXPORT_FORMAT_VERSION, exportCharacter, readExportManifest } from './export.js';
export type {
  ExportBindings,
  ExportCharacterOptions,
  ExportManifest,
  ExportResult,
  Facing,
  ManifestAnimation,
} from './export.js';

export { verifyReproducible } from './reproduce.js';
export type {
  ReproducibleKind,
  ReproducibilityMismatch,
  ReproducibilityReport,
  VerifyReproducibleOptions,
} from './reproduce.js';

export { validateArtifact, validateExport, validateStore } from './validate.js';
export type {
  ArtifactContext,
  ArtifactKind,
  ExportValidationReport,
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
