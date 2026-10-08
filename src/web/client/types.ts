/**
 * View-model types for the browser app.
 *
 * These are the shape of the core command surface, imported **type-only** so no
 * Node code (`node:fs` behind the store) is ever pulled into the browser bundle.
 * The browser only sees JSON from the API; these types describe it.
 */

export type {
  AssetKind,
  AssetRef,
  ClipDraft,
  CutList,
  FrameRange,
  RectGeometry,
  RepairOperation,
  RepairOperationInput,
  RepairScript,
  RepairState,
  RepairTool,
  RepairWarning,
  RepairWarningCode,
  ScannedAsset,
  ScannedCharacter,
  ScannedDraft,
  ScannedExport,
  ScannedRecording,
  Segment,
  StoreScan,
  StrokeGeometry,
} from '../../core/index.js';
