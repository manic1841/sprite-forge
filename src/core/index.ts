/**
 * The core command surface.
 *
 * Front ends (CLI, web) call these; core never imports UI or HTTP types. The
 * filesystem lives behind `./store/` only.
 */

export { scan, readStoreTree } from './scan.js';
export type { CharacterTree, StoreTree } from './scan.js';

/** A pixel rectangle in source coordinates (a Segment's box, a Repair rect). */
export type { Bounds } from './frames.js';

export { ingestRecording, readRecordingDelays, readRecordingFrame } from './ingest.js';
export type {
  IngestRecordingOptions,
  IngestedRecording,
  RecordingDelays,
  RecordingFrame,
} from './ingest.js';

export { BLANK_CANVAS, createCharacter } from './character.js';
export type {
  Canvas,
  CanvasAnchor,
  CreateCharacterOptions,
  CreatedCharacter,
} from './character.js';

export { addSegment, readCutList, removeSegment, renameSegment, setSegmentRange, setSegmentRect } from './segments.js';
export type {
  AddSegmentOptions,
  CutList,
  RemoveSegmentOptions,
  RenameSegmentOptions,
  Segment,
  SetSegmentRangeOptions,
  SetSegmentRectOptions,
} from './segments.js';

export {
  deriveAnchor,
  extractClipDraft,
  readClipDraft,
  readClipDraftFrame,
  renderSegmentFrames,
  segmentContentBounds,
} from './draft.js';
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
  SegmentContentBoundsOptions,
} from './draft.js';

export {
  listSequenceDrafts,
  readSequenceDraft,
  removeSequenceDraft,
  saveSequenceDraft,
} from './sequenceDraft.js';
export type {
  SaveSequenceDraftOptions,
  SequenceDraft,
  SequenceDraftDescriptor,
  SequenceDraftRef,
} from './sequenceDraft.js';

export {
  commitDraft,
  commitSequence,
  deleteAsset,
  discardDraft,
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
  DeleteAssetOptions,
  ForkAssetOptions,
  ReadAssetSheetOptions,
  RenderedSequenceSheet,
  SequenceFork,
  SequenceProvenance,
} from './assets.js';

export {
  contentFloor,
  fitCanvasToContent,
  frameCanvasFromSegment,
  readCharacterAlignment,
  readDraftAlignment,
  resizeCanvas,
  setPlacementOffset,
} from './alignment.js';
export type {
  AlignmentState,
  AlignmentWarning,
  AlignmentWarningCode,
  CharacterAlignment,
  CharacterScopedOptions,
  ContentFloor,
  FrameCanvasFromSegmentOptions,
  PlacementOffset,
  ReadDraftAlignmentOptions,
  ResizeCanvasOptions,
  ResizeCanvasResult,
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

export { ForgeError, StoreError, ValidationError } from './errors.js';export type { ValidationIssue } from './errors.js';

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

export { withStoreLock } from './store/index.js';
