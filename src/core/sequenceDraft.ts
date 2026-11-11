/**
 * `sequence draft` — a Sequence composition that is still being edited.
 *
 * A Sequence has no frame Draft: its recipe *is* the ordered Clip list (Rule
 * 7.2). Composition therefore lives in a small persisted descriptor under
 * `characters/<character-id>/sequence-drafts/<draft-id>/draft.json`, so a
 * half-built composition survives a reload the same way a frame Draft does. Its
 * shape is **not** a frozen format (format-spec §11).
 *
 * A composition belongs to its **Character**, not to a Sequence Asset: it can be
 * started before any Sequence exists, and an Asset only appears on commit.
 */

import { StoreError } from './errors.js';
import { assertValidId } from './ids.js';
import {
  characterDir,
  sequenceDraftDir,
  sequenceDraftPath,
  sequenceDraftsDir,
} from './layout.js';
import { readCommittedClip } from './assets.js';
import {
  listDirectories,
  pathExists,
  readJsonFile,
  removePath,
  writeJsonFile,
} from './store/index.js';
import { SPRITE_FORGE_VERSION } from './version.js';

/** The persisted recipe of a Sequence being composed. */
export interface SequenceDraftDescriptor {
  /** The draft id (its folder name). */
  id: string;
  /** The owning Character. */
  characterId: string;
  /** The ordered source Clip ids, concatenated end to end on commit. */
  clips: string[];
  /** The Sequence this composition was forked from, or `null`. */
  forkOf: string | null;
  /** The tool version that produced the draft. */
  spriteForgeVersion: string;
}

/** A read-back Sequence draft: its descriptor plus its directory. */
export interface SequenceDraft extends SequenceDraftDescriptor {
  /** Store-relative POSIX directory. */
  dir: string;
}

/** Inputs for {@link saveSequenceDraft}. */
export interface SaveSequenceDraftOptions {
  characterId: string;
  /** The draft id; a free `composition` series id is used when omitted. */
  draftId?: string;
  /** The ordered source Clip ids. */
  clips: string[];
  /** The forked-from Sequence, if this composition came from one. */
  forkOf?: string | null;
}

/** Inputs for {@link readSequenceDraft} / {@link removeSequenceDraft}. */
export interface SequenceDraftRef {
  characterId: string;
  draftId: string;
}

/**
 * Create or overwrite a Sequence draft.
 *
 * Every Clip id must name a committed Clip of the same Character, so a
 * composition can never point at a missing or foreign asset. An empty list is
 * allowed: a composition can start before its first Clip is added.
 */
export async function saveSequenceDraft(
  root: string,
  options: SaveSequenceDraftOptions,
): Promise<SequenceDraft> {
  const { characterId } = options;
  assertValidId(characterId, 'character', 'characterId');
  if (!Array.isArray(options.clips)) {
    throw new StoreError('A Sequence draft needs a Clip list.');
  }
  for (const clipId of options.clips) {
    assertValidId(clipId, 'clip', 'a source clip id');
    await readCommittedClip(root, characterId, clipId);
  }
  if (options.forkOf != null) {
    assertValidId(options.forkOf, 'sequence', 'forkOf');
  }

  const draftId = options.draftId ?? (await freeDraftId(root, characterId));
  assertValidId(draftId, 'draft', 'draftId');

  const descriptor: SequenceDraftDescriptor = {
    id: draftId,
    characterId,
    clips: [...options.clips],
    forkOf: options.forkOf ?? null,
    spriteForgeVersion: SPRITE_FORGE_VERSION,
  };
  await writeJsonFile(root, sequenceDraftPath(characterId, draftId), descriptor);
  return { ...descriptor, dir: sequenceDraftDir(characterId, draftId) };
}

/** Read a Sequence draft; a missing or malformed one is a hard error. */
export async function readSequenceDraft(
  root: string,
  options: SequenceDraftRef,
): Promise<SequenceDraft> {
  const { characterId, draftId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(draftId, 'draft', 'draftId');

  const rel = sequenceDraftPath(characterId, draftId);
  if (!(await pathExists(root, rel))) {
    throw new StoreError(`Sequence draft not found: ${rel}`);
  }
  const raw = (await readJsonFile(root, rel)) as Partial<SequenceDraftDescriptor>;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof raw.id !== 'string' ||
    raw.id !== draftId ||
    typeof raw.characterId !== 'string' ||
    raw.characterId !== characterId ||
    !Array.isArray(raw.clips) ||
    !raw.clips.every((clipId) => typeof clipId === 'string') ||
    !(raw.forkOf === null || raw.forkOf === undefined || typeof raw.forkOf === 'string')
  ) {
    throw new StoreError(`Malformed Sequence draft: ${rel}`);
  }
  return {
    id: draftId,
    characterId,
    clips: [...raw.clips],
    forkOf: raw.forkOf ?? null,
    spriteForgeVersion:
      typeof raw.spriteForgeVersion === 'string' ? raw.spriteForgeVersion : SPRITE_FORGE_VERSION,
    dir: sequenceDraftDir(characterId, draftId),
  };
}

/** List a Character's Sequence draft ids, alphabetical. */
export async function listSequenceDrafts(
  root: string,
  characterId: string,
): Promise<string[]> {
  assertValidId(characterId, 'character', 'characterId');
  const ids = await listDirectories(root, sequenceDraftsDir(characterId));
  const withRecipe: string[] = [];
  for (const id of ids) {
    if (await pathExists(root, sequenceDraftPath(characterId, id))) {
      withRecipe.push(id);
    }
  }
  return withRecipe;
}

/** Remove a Sequence draft. A missing one is not an error. */
export async function removeSequenceDraft(
  root: string,
  options: SequenceDraftRef,
): Promise<void> {
  const { characterId, draftId } = options;
  assertValidId(characterId, 'character', 'characterId');
  assertValidId(draftId, 'draft', 'draftId');
  await removePath(root, sequenceDraftDir(characterId, draftId));
}

/** The first free id of the `composition`, `composition-2`, … series. */
async function freeDraftId(root: string, characterId: string): Promise<string> {
  if (!(await pathExists(root, `${characterDir(characterId)}/sequence-drafts`))) {
    return 'composition';
  }
  const taken = new Set(await listDirectories(root, sequenceDraftsDir(characterId)));
  if (!taken.has('composition')) {
    return 'composition';
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `composition-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return 'composition';
}
