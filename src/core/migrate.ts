/**
 * `migrate` — the deliberate, one-time rewrite of a store's artifacts across a
 * breaking format change.
 *
 * Store artifacts carry no version field (format-spec §0 Rule 0.2), so nothing can
 * sniff a store's age. A break is therefore migrated by an explicit command that
 * the caller runs once, by hand, on a store under version control — never inferred
 * at read time (format-spec §10, ADR-0010).
 *
 * The one migration today is the 2.0.0 contract: `delaysMs` (a per-frame array) is
 * rewritten to `timing` (a base `frameMs` plus a sparse `overrideMs`), in a Clip or
 * Sequence `meta.json` and in an Export Manifest's animations. Drafts are not a
 * frozen format (format-spec §11) and keep their array, so they are left alone.
 *
 * The rewrite is idempotent: an artifact that already carries `timing` is skipped.
 */

import { StoreError } from './errors.js';
import { readStoreTree } from './scan.js';
import { assetMetaPath, manifestPath } from './layout.js';
import { pathExists, readJsonFile, writeJsonFile } from './store/index.js';
import { timingFromDelays } from './timing.js';

/** One artifact the migration rewrote. */
export interface MigratedArtifact {
  /** Store-relative POSIX path. */
  artifact: string;
  /** What was changed, for the operator's log. */
  change: string;
}

/** The result of {@link migrateStore}. */
export interface MigrationReport {
  /** Artifacts rewritten. Empty when the store was already current. */
  migrated: MigratedArtifact[];
  /** Artifacts already in the current shape and left untouched. */
  skipped: string[];
}

/** Inputs for {@link migrateStore}. */
export interface MigrateStoreOptions {
  /** Report what would change without writing anything. */
  dryRun?: boolean;
}

/** A per-frame `delaysMs` array on a meta-shaped object, and its timing. */
function rewriteMeta(
  value: Record<string, unknown>,
  artifact: string,
): { changed: boolean; change?: string } {
  if (value.timing !== undefined) {
    return { changed: false };
  }
  const delaysMs = value.delaysMs;
  if (!Array.isArray(delaysMs) || delaysMs.length === 0) {
    throw new StoreError(`${artifact} carries neither "timing" nor a usable "delaysMs".`);
  }
  const frameCount = value.frameCount;
  if (typeof frameCount === 'number' && delaysMs.length !== 1 && delaysMs.length !== frameCount) {
    throw new StoreError(
      `${artifact} has ${delaysMs.length} delays for ${frameCount} frames; cannot collapse it.`,
    );
  }
  // A uniform one-element array keeps its one value; anything longer collapses to
  // its mode plus overrides.
  const expanded =
    delaysMs.length === 1 && typeof frameCount === 'number'
      ? Array.from({ length: frameCount }, () => Number(delaysMs[0]))
      : (delaysMs as number[]);
  const timing = timingFromDelays(expanded);
  delete value.delaysMs;
  value.timing = timing;
  const detail =
    timing.overrideMs === undefined
      ? `delaysMs -> timing {frameMs: ${timing.frameMs}}`
      : `delaysMs[${delaysMs.length}] -> timing {frameMs: ${timing.frameMs}, ` +
        `${Object.keys(timing.overrideMs).length} override(s)}`;
  return { changed: true, change: detail };
}

/**
 * Migrate a store to the current artifact contract. Pass `dryRun` to preview.
 *
 * Nothing is written until every planned rewrite has been computed, so a store that
 * cannot be migrated is left exactly as it was (barring an I/O failure mid-write).
 */
export async function migrateStore(
  root: string,
  options: MigrateStoreOptions = {},
): Promise<MigrationReport> {
  const dryRun = options.dryRun === true;
  const tree = await readStoreTree(root);

  const report: MigrationReport = { migrated: [], skipped: [] };
  const writes: Array<{ artifact: string; value: Record<string, unknown> }> = [];

  for (const character of tree.characters) {
    for (const kind of ['clip', 'sequence'] as const) {
      for (const id of kind === 'clip' ? character.clips : character.sequences) {
        const artifact = assetMetaPath(character.id, kind, id);
        if (!(await pathExists(root, artifact))) {
          continue;
        }
        const value = (await readJsonFile(root, artifact)) as Record<string, unknown>;
        const { changed, change } = rewriteMeta(value, artifact);
        if (changed) {
          report.migrated.push({ artifact, change: change! });
          writes.push({ artifact, value });
        } else {
          report.skipped.push(artifact);
        }
      }
    }
  }

  for (const target of tree.exports) {
    const artifact = manifestPath(target);
    if (!(await pathExists(root, artifact))) {
      continue;
    }
    const value = (await readJsonFile(root, artifact)) as Record<string, unknown>;
    const animations = value.animations;
    if (!animations || typeof animations !== 'object') {
      throw new StoreError(`${artifact} has no "animations" object.`);
    }
    let touched = false;
    for (const [id, animation] of Object.entries(animations as Record<string, unknown>)) {
      if (!animation || typeof animation !== 'object') {
        continue;
      }
      const { changed, change } = rewriteMeta(
        animation as Record<string, unknown>,
        `${artifact}#animations.${id}`,
      );
      if (changed) {
        report.migrated.push({ artifact: `${artifact}#animations.${id}`, change: change! });
        touched = true;
      }
    }
    if (value.formatVersion === '1.0.0') {
      value.formatVersion = '2.0.0';
      report.migrated.push({ artifact, change: 'formatVersion 1.0.0 -> 2.0.0' });
      touched = true;
    }
    if (touched) {
      writes.push({ artifact, value });
    } else {
      report.skipped.push(artifact);
    }
  }

  if (!dryRun) {
    for (const { artifact, value } of writes) {
      await writeJsonFile(root, artifact, value);
    }
  }
  return report;
}
