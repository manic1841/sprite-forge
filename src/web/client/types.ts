/**
 * View-model types for the browser app.
 *
 * These are the shape of the core command surface, imported **type-only** so no
 * Node code (`node:fs` behind the store) is ever pulled into the browser bundle.
 * The browser only sees JSON from the API; these types describe it.
 */

export type {
  AlignmentState,
  AlignmentWarning,
  AlignmentWarningCode,
  AssetKind,
  AssetRef,
  CharacterAlignment,
  ClipDraft,
  CommittedAsset,
  CommittedSequence,
  CreatedCharacter,
  CutList,
  DerivedAnchor,
  ExpandCanvasResult,
  ExportBindings,
  ExportManifest,
  ExportResult,
  Facing,
  FrameRange,
  IngestedRecording,
  PlacementOffset,
  RectGeometry,
  RepairOperation,
  RepairOperationInput,
  RepairScript,
  RepairState,
  RepairTool,
  RepairWarning,
  RepairWarningCode,
  ReproducibilityReport,
  ScannedAsset,
  ScannedCharacter,
  ScannedDraft,
  ScannedExport,
  ScannedRecording,
  Segment,
  SequenceFork,
  StoreScan,
  StrokeGeometry,
} from '../../core/index.js';

/**
 * A whole-store check report.
 *
 * Deliberately *not* the core `StoreValidationReport`: the core throws with every
 * issue attached, while the workbench wants one list it can render either way.
 */
export interface StoreCheckReport {
  ok: boolean;
  root: string;
  artifactCount: number;
  problems: { artifact: string; path: string; message: string }[];
}
