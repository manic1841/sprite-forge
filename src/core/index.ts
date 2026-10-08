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
