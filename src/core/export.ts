/**
 * `export` — gather an Asset subset for one Character and one consumer target
 * into a self-contained **Export** (GLOSSARY.md).
 *
 * The consumer reads one **Manifest** and nothing else (`docs/export-contract.md`).
 * The Manifest is **canvas-level** (ADR-0008): the shared `canvas` and `anchor`
 * appear once and each animation carries only `{sheet, frameCount, delaysMs, loop,
 * flipsFacing?}` — no hitbox, no per-animation mirror flag. Direction is the
 * consumer's **Facing** (ADR-0009); a `flipsFacing` animation flips it on
 * completion.
 *
 * Export is **closed** (`docs/format-spec.md` §9): every declared Situation must
 * be bound, every bound id must exist in `animations` whose sheet must exist, and
 * the manifest canvas must equal the Character's — otherwise the export fails.
 *
 * The only versioned artifact in the whole contract is the Manifest's
 * `formatVersion` (semver, Rule 0.2 / Rule 9.1).
 */

import type { AssetMeta } from './assets.js';
import type { Canvas } from './character.js';
import { StoreError } from './errors.js';
import { isValidId } from './ids.js';
import {
  assetMetaPath,
  canvasPath,
  clipDir,
  clipsDir,
  exportDir,
  exportSheetPath,
  manifestPath,
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
import type { AssetKind } from './types.js';
import { validateArtifact, validateExport } from './validate.js';
import { SPRITE_FORGE_VERSION } from './version.js';

/**
 * The semver of the Export contract (Rule 9.1). This is the **only** versioned
 * artifact in the whole contract; a major bump is a breaking change for the
 * consumer.
 */
export const EXPORT_FORMAT_VERSION = '1.0.0';

/** The direction art was drawn in; the consumer mirrors against it (ADR-0009). */
export type Facing = 'right' | 'left';

/** Situation id -> one or more animation ids (Rule 9.2: consumer vocabulary only). */
export type ExportBindings = Record<string, string[]>;

/** One exported animation in the canvas-level Manifest (`docs/export-contract.md`). */
export interface ManifestAnimation {
  /** Path to the strip, relative to the manifest, POSIX. */
  sheet: string;
  /** Number of frames (each is `canvas.width × canvas.height`). */
  frameCount: number;
  /** Per-frame duration in ms; one value means uniform. */
  delaysMs: number[];
  /** Whether this animation loops when shown. */
  loop: boolean;
  /** When true, the animation flips the consumer's Facing on completion. */
  flipsFacing?: boolean;
}

/** The single file a consumer reads (`exports/<target>/manifest.json`, §9). */
export interface ExportManifest {
  /** Semver of this contract; the only versioned field in the contract. */
  formatVersion: string;
  /** The consumer this Export is for. */
  target: string;
  /** The Character exported. */
  character: string;
  /** The direction the art was drawn in. */
  authoredFacing: Facing;
  /** The shared frame size and its Anchor; every animation uses it. */
  canvas: Canvas;
  /** The exported Assets, keyed by animation id. */
  animations: Record<string, ManifestAnimation>;
  /** Situation -> one or more animation ids. */
  bindings: ExportBindings;
  /** Provenance for the consumer: tool version and export time. */
  lock: { spriteForgeVersion: string; exportedAt: string };
}

/** Inputs for {@link exportCharacter}. */
export interface ExportCharacterOptions {
  /** The Character whose Assets are exported. */
  characterId: string;
  /** The consumer target; the export lands at `exports/<target>/`. */
  target: string;
  /** The committed Asset ids to export; defaults to every committed Asset. */
  animations?: string[];
  /** Situation -> one or more animation ids (consumer vocabulary, Rule 9.2). */
  bindings: ExportBindings;
  /** Animation ids that flip the consumer's Facing on completion. */
  flipsFacing?: string[];
  /**
   * The Situations the consumer declares. Every one must be bound — this is what
   * makes the Export *closed* (§9). Defaults to the `bindings` keys.
   */
  situations?: string[];
  /** The direction art was authored in; defaults to `right` (ADR-0009). */
  authoredFacing?: Facing;
  /** ISO export time for `lock`; defaults to now (injectable for determinism). */
  exportedAt?: string;
  /** The contract version; defaults to {@link EXPORT_FORMAT_VERSION}. */
  formatVersion?: string;
}

/** A written Export as returned by {@link exportCharacter}. */
export interface ExportResult {
  target: string;
  /** Store-relative POSIX path of the manifest. */
  manifestPath: string;
  /** Store-relative POSIX paths of the copied sheets, in animation order. */
  sheetPaths: string[];
  manifest: ExportManifest;
}

/**
 * Export an Asset subset of a Character as a closed Manifest plus one sheet per
 * exported Asset.
 *
 * Reads each selected committed Asset (Clip or Sequence), copies its baked
 * `sheet.png` into `exports/<target>/clips/<id>.png`, and writes a canvas-level
 * `manifest.json`. The target folder is replaced so the Export is exactly the
 * selected subset. The result is validated against the schema and every
 * closed-export rule before it is returned.
 */
export async function exportCharacter(
  root: string,
  options: ExportCharacterOptions,
): Promise<ExportResult> {
  const { characterId, target, bindings } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidTarget(target);

  const canvas = await readCanvas(root, characterId);
  const animationIds = await resolveAnimationIds(root, characterId, options.animations);
  const flips = new Set(options.flipsFacing ?? []);
  for (const id of flips) {
    if (!animationIds.includes(id)) {
      throw new StoreError(`flipsFacing names animation "${id}", which is not exported.`);
    }
  }

  // Build the canvas-level animations map and copy each Asset's sheet.
  const animations: Record<string, ManifestAnimation> = {};
  const sheetPaths: string[] = [];
  const sheets: Array<{ relPath: string; data: Buffer }> = [];
  for (const id of animationIds) {
    const asset = await readExportedAsset(root, characterId, id);
    animations[id] = {
      sheet: `clips/${id}.png`,
      frameCount: asset.meta.frameCount,
      delaysMs: [...asset.meta.delaysMs],
      loop: asset.meta.loop,
      ...(flips.has(id) ? { flipsFacing: true } : {}),
    };
    const relPath = exportSheetPath(target, id);
    sheets.push({ relPath, data: asset.sheet });
    sheetPaths.push(relPath);
  }

  assertBindings(bindings, animationIds, options.situations);

  const manifest: ExportManifest = {
    formatVersion: options.formatVersion ?? EXPORT_FORMAT_VERSION,
    target,
    character: characterId,
    authoredFacing: options.authoredFacing ?? 'right',
    canvas,
    animations,
    bindings: cloneBindings(bindings),
    lock: {
      spriteForgeVersion: SPRITE_FORGE_VERSION,
      exportedAt: options.exportedAt ?? new Date().toISOString(),
    },
  };

  validateArtifact('manifest', manifest, { artifact: manifestPath(target) });

  // Replace the target folder so a re-export is exactly the selected subset.
  await removePath(root, exportDir(target));
  for (const sheet of sheets) {
    await writeBinaryFile(root, sheet.relPath, sheet.data);
  }
  await writeJsonFile(root, manifestPath(target), manifest);

  // Enforce the cross-artifact rules of a closed Export against what was written
  // (format-spec §9); any violation aborts the export.
  await validateExport(root, target);

  return { target, manifestPath: manifestPath(target), sheetPaths, manifest };
}

/**
 * Read an existing Export: validate the manifest against the schema and every
 * closed-export rule, then return it with its sheet paths. The Export stage's
 * "live manifest" reads through here, so a hand-edited or stale bundle is a hard
 * error rather than something the consumer would silently misread.
 */
export async function readExportManifest(root: string, target: string): Promise<ExportResult> {
  const { manifest } = await validateExport(root, target);
  const sheetPaths = Object.values(manifest.animations).map(
    (animation) => `${exportDir(target)}/${animation.sheet}`,
  );
  return { target, manifestPath: manifestPath(target), sheetPaths, manifest };
}

// --- internals ----------------------------------------------------------------

/** Resolve the Assets to export; omitted means every committed Asset of the Character. */
async function resolveAnimationIds(
  root: string,
  characterId: string,
  requested: string[] | undefined,
): Promise<string[]> {
  if (requested) {
    for (const id of requested) {
      assertValidId(id, 'asset', 'an animation id');
    }
    return [...requested];
  }
  const clips = await listDirectories(root, clipsDir(characterId));
  const sequences = await listDirectories(root, sequencesDir(characterId));
  return [...clips, ...sequences];
}

/** Read a committed Asset's kind, validated meta and baked sheet bytes. */
async function readExportedAsset(
  root: string,
  characterId: string,
  id: string,
): Promise<{ kind: AssetKind; meta: AssetMeta; sheet: Buffer }> {
  const isClip = await pathExists(root, clipDir(characterId, id));
  const isSequence = await pathExists(root, sequenceDir(characterId, id));
  if (isClip && isSequence) {
    throw new StoreError(
      `Asset id "${id}" is both a Clip and a Sequence for Character "${characterId}"; ` +
        `Clip and Sequence ids share one namespace.`,
    );
  }
  if (!isClip && !isSequence) {
    throw new StoreError(`No committed Asset "${id}" for Character "${characterId}".`);
  }
  const kind: AssetKind = isClip ? 'clip' : 'sequence';

  const metaRel = assetMetaPath(characterId, kind, id);
  if (!(await pathExists(root, metaRel))) {
    throw new StoreError(`Committed Asset "${id}" has no meta.json (${metaRel}).`);
  }
  const meta = await readJsonFile(root, metaRel);
  validateArtifact('asset-meta', meta, { artifact: metaRel, folderId: id });

  const sheetRel = sheetPath(characterId, kind, id);
  if (!(await pathExists(root, sheetRel))) {
    throw new StoreError(`Committed Asset "${id}" has no sheet.png (${sheetRel}).`);
  }
  return { kind, meta: meta as AssetMeta, sheet: await readBinaryFile(root, sheetRel) };
}

/**
 * Enforce the closed-export binding rules that concern the caller's declared
 * Situations: every declared Situation is bound, and every bound id is exported.
 * Situation ids are consumer vocabulary (Rule 9.2) and never enter the store.
 */
function assertBindings(
  bindings: ExportBindings,
  animationIds: string[],
  situations: string[] | undefined,
): void {
  const exported = new Set(animationIds);
  for (const [situation, ids] of Object.entries(bindings)) {
    assertValidId(situation, 'situation', `Situation "${situation}"`);
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new StoreError(`Situation "${situation}" must bind at least one animation id.`);
    }
    for (const id of ids) {
      if (!exported.has(id)) {
        throw new StoreError(
          `Situation "${situation}" binds animation "${id}", which is not in the Export.`,
        );
      }
    }
  }
  const declared = situations ?? Object.keys(bindings);
  for (const situation of declared) {
    if (!(situation in bindings)) {
      throw new StoreError(
        `Situation "${situation}" is declared by the consumer but not bound; the Export is not closed.`,
      );
    }
  }
}

/** Copy the caller's bindings so the result cannot be mutated from outside. */
function cloneBindings(bindings: ExportBindings): ExportBindings {
  const clone: ExportBindings = {};
  for (const [situation, ids] of Object.entries(bindings)) {
    clone[situation] = [...ids];
  }
  return clone;
}

/** Read and validate the Character's Canvas; the Manifest must equal it (§9). */
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

/** Reject an id that does not match the id grammar before it becomes a path segment. */
function assertValidId(id: string, noun: string, label: string): void {
  if (!isValidId(id)) {
    throw new StoreError(`Invalid ${label} "${id}" (${noun} id): must match /^[a-z][a-z0-9-]*$/.`);
  }
}

/** The target is a folder name under `exports/`, so it must be a safe id. */
function assertValidTarget(target: string): void {
  if (!isValidId(target)) {
    throw new StoreError(
      `Invalid export target "${target}": must match /^[a-z][a-z0-9-]*$/.`,
    );
  }
}
