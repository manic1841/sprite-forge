/**
 * `validate` — check store artifacts against the frozen JSON Schemas, plus the
 * rules a schema cannot express.
 *
 * Validation is a **hard error** (format-spec §10): a store that fails is never
 * warn-and-continue. `validateStore` aggregates *every* problem before throwing,
 * so a caller sees all of them at once.
 *
 * Schema handling: draft 2020-12, objects closed (`additionalProperties: false`).
 * The schemas are read from the repo root; nothing is vendored into the store.
 */

import { createRequire } from 'node:module';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';

// ajv-formats is CJS whose callable plugin is the module itself; load it through
// CJS interop so it works identically under tsx, vitest and the built ESM CLI.
const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin;
import { ValidationError, type ValidationIssue } from './errors.js';
import {
  ASSET_META_FILE,
  ASSET_PROVENANCE_FILE,
  canvasPath,
  clipDir,
  cutsPath,
  manifestPath,
  repairPath,
  sequenceDir,
} from './layout.js';
import { readStoreTree } from './scan.js';
import { pathExists, readJsonFile } from './store/index.js';
import { readSchemaSource, type SchemaName } from './store/schemas.js';

/** The artifact kinds the store holds, each backed by one schema file. */
export type ArtifactKind =
  | 'cuts'
  | 'canvas'
  | 'asset-meta'
  | 'clip-provenance'
  | 'sequence-provenance'
  | 'repair'
  | 'manifest';

const SCHEMA_FOR: Record<ArtifactKind, SchemaName> = {
  cuts: 'cuts',
  canvas: 'canvas',
  'asset-meta': 'asset.meta',
  'clip-provenance': 'clip.provenance',
  'sequence-provenance': 'sequence.provenance',
  repair: 'repair',
  manifest: 'export.manifest',
};

/** Context a cross-artifact rule may need. */
export interface ArtifactContext {
  /** The artifact's path (or label), used in issues. */
  artifact?: string;
  /** The folder the artifact lives in, for the "folder equals id" rule. */
  folderId?: string;
}

/** One artifact that `validateStore` checked. */
export interface ValidatedArtifact {
  kind: ArtifactKind;
  path: string;
}

/** What `validateStore` checked, on success. */
export interface StoreValidationReport {
  root: string;
  artifacts: ValidatedArtifact[];
}

/**
 * Validate a single in-memory artifact. Throws `ValidationError` (with every
 * issue) if it is invalid. Useful for validate-on-read in later stages.
 */
export function validateArtifact(
  kind: ArtifactKind,
  value: unknown,
  context: ArtifactContext = {},
): void {
  const issues = collectArtifactIssues(kind, value, context);
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
}

/** Validate every artifact in the store. Throws one aggregated `ValidationError`. */
export async function validateStore(root: string): Promise<StoreValidationReport> {
  const issues: ValidationIssue[] = [];
  const artifacts: ValidatedArtifact[] = [];

  const check = async (
    kind: ArtifactKind,
    artifactPath: string,
    context: ArtifactContext = {},
  ): Promise<void> => {
    if (!(await pathExists(root, artifactPath))) {
      return;
    }
    const value = await readJsonFile(root, artifactPath);
    artifacts.push({ kind, path: artifactPath });
    issues.push(...collectArtifactIssues(kind, value, { ...context, artifact: artifactPath }));
  };

  const tree = await readStoreTree(root);

  for (const recordingId of tree.recordings) {
    await check('cuts', cutsPath(recordingId));
  }

  for (const character of tree.characters) {
    await check('canvas', canvasPath(character.id));

    for (const clipId of character.clips) {
      const dir = clipDir(character.id, clipId);
      await check('asset-meta', `${dir}/${ASSET_META_FILE}`, { folderId: clipId });
      await check('clip-provenance', `${dir}/${ASSET_PROVENANCE_FILE}`);
    }
    for (const sequenceId of character.sequences) {
      const dir = sequenceDir(character.id, sequenceId);
      await check('asset-meta', `${dir}/${ASSET_META_FILE}`, { folderId: sequenceId });
      await check('sequence-provenance', `${dir}/${ASSET_PROVENANCE_FILE}`);
    }
    for (const clipId of character.repairs) {
      await check('repair', repairPath(character.id, clipId));
    }
  }

  for (const target of tree.exports) {
    await check('manifest', manifestPath(target));
  }

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  return { root, artifacts };
}

// --- internals ----------------------------------------------------------------

function collectArtifactIssues(
  kind: ArtifactKind,
  value: unknown,
  context: ArtifactContext,
): ValidationIssue[] {
  const artifact = context.artifact ?? '<value>';
  const issues: ValidationIssue[] = [];

  for (const error of schemaErrors(kind, value)) {
    issues.push({
      artifact,
      path: error.instancePath,
      message: error.message ?? 'is invalid',
    });
  }

  issues.push(...crossArtifactIssues(kind, value, artifact, context));
  return issues;
}

/** Cross-file rules that JSON Schema cannot express (format-spec §2, §3.1, §5.1, §0). */
function crossArtifactIssues(
  kind: ArtifactKind,
  value: unknown,
  artifact: string,
  context: ArtifactContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (path: string, message: string): void => {
    issues.push({ artifact, path, message });
  };

  if (kind === 'cuts' && isRecord(value)) {
    const { frameCount, cuts } = value;
    if (Array.isArray(cuts)) {
      const seenIds = new Set<string>();
      cuts.forEach((cut, index) => {
        if (!isRecord(cut)) {
          return;
        }
        const { id, startFrame, endFrame } = cut;
        if (isNumber(startFrame) && isNumber(endFrame)) {
          if (!(endFrame > startFrame)) {
            issue(
              `/cuts/${index}/endFrame`,
              `endFrame (${endFrame}) must be greater than startFrame (${startFrame})`,
            );
          }
          if (isNumber(frameCount) && endFrame > frameCount) {
            issue(
              `/cuts/${index}/endFrame`,
              `endFrame (${endFrame}) must not exceed the Recording frameCount (${frameCount})`,
            );
          }
        }
        if (typeof id === 'string') {
          if (seenIds.has(id)) {
            issue(`/cuts/${index}/id`, `cut id "${id}" is not unique within the Recording`);
          }
          seenIds.add(id);
        }
      });
    }
  }

  if (kind === 'canvas' && isRecord(value)) {
    const { width, height, anchor } = value;
    if (isNumber(width) && isNumber(height) && isRecord(anchor)) {
      const { x, y } = anchor;
      if (isNumber(x) && x !== width / 2) {
        issue('/anchor/x', `anchor.x must equal width/2 (${width / 2}); got ${x}`);
      }
      if (isNumber(y) && y !== height) {
        issue('/anchor/y', `anchor.y must equal height (${height}); got ${y}`);
      }
    }
  }

  if (kind === 'asset-meta' && isRecord(value)) {
    const { frameCount, delaysMs, id } = value;
    if (isNumber(frameCount) && Array.isArray(delaysMs)) {
      if (delaysMs.length !== 1 && delaysMs.length !== frameCount) {
        issue(
          '/delaysMs',
          `delaysMs must have 1 (uniform) or frameCount (${frameCount}) values; got ${delaysMs.length}`,
        );
      }
    }
    if (context.folderId !== undefined && typeof id === 'string' && id !== context.folderId) {
      issue('/id', `id "${id}" must equal the folder name "${context.folderId}"`);
    }
  }

  return issues;
}

// --- Ajv wiring ---------------------------------------------------------------

let validateCache: Map<ArtifactKind, ValidateFunction> | undefined;

function validators(): Map<ArtifactKind, ValidateFunction> {
  if (validateCache) {
    return validateCache;
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  validateCache = new Map(
    (Object.keys(SCHEMA_FOR) as ArtifactKind[]).map((kind) => [
      kind,
      ajv.compile(readSchemaSource(SCHEMA_FOR[kind]) as object),
    ]),
  );
  return validateCache;
}

function schemaErrors(kind: ArtifactKind, value: unknown): ErrorObject[] {
  const validate = validators().get(kind)!;
  return validate(value) ? [] : (validate.errors ?? []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
