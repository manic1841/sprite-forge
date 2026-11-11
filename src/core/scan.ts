/**
 * `scan` — discover the store's contents by walking its directory tree.
 *
 * There is no catalog or index file (ADR-0003): the tree is the single source of
 * truth. `scan` is pure discovery — it does no validation, and it writes nothing.
 */

import { StoreError } from './errors.js';
import {
  CHARACTERS_DIR,
  EXPORTS_DIR,
  RECORDINGS_DIR,
  canvasPath,
  characterDir,
  clipDir,
  draftDir,
  draftPath,
  draftsDir,
  exportDir,
  recordingDir,
  sequenceDir,
  sequenceDraftDir,
  sequenceDraftPath,
  sequenceDraftsDir,
} from './layout.js';
import { isDirectory, listDirectories, pathExists } from './store/index.js';
import type { ScannedAsset, ScannedCharacter, ScannedDraft, StoreScan } from './types.js';

/** A Character as found on disk, before it is shaped into a scan result. */
export interface CharacterTree {
  id: string;
  clips: string[];
  sequences: string[];
  repairs: string[];
  drafts: string[];
  sequenceDrafts: string[];
}

/** The raw directory tree of a store: ids only, no artifact contents. */
export interface StoreTree {
  recordings: string[];
  characters: CharacterTree[];
  exports: string[];
}

/** Walk the store's directory tree. Throws if the root is missing. */
export async function readStoreTree(root: string): Promise<StoreTree> {
  if (!(await isDirectory(root, ''))) {
    throw new StoreError(`Store root not found or not a directory: ${root}`);
  }

  const recordings = await listDirectories(root, RECORDINGS_DIR);
  const characterIds = await listDirectories(root, CHARACTERS_DIR);
  const characters: CharacterTree[] = [];
  for (const id of characterIds) {
    characters.push({
      id,
      clips: await listDirectories(root, `${characterDir(id)}/clips`),
      sequences: await listDirectories(root, `${characterDir(id)}/sequences`),
      repairs: await listDirectories(root, `${characterDir(id)}/repairs`),
      drafts: await listDirectories(root, draftsDir(id)),
      sequenceDrafts: await listDirectories(root, sequenceDraftsDir(id)),
    });
  }
  const exports = await listDirectories(root, EXPORTS_DIR);

  return { recordings, characters, exports };
}

/** List the store's Recordings, Characters (with committed Assets) and Exports. */
export async function scan(root: string): Promise<StoreScan> {
  const tree = await readStoreTree(root);

  const characters: ScannedCharacter[] = [];
  for (const character of tree.characters) {
    // A Character is recognised by its `canvas.json` (format-spec §3): a bare
    // folder under `characters/` is not a Character.
    if (!(await pathExists(root, canvasPath(character.id)))) {
      continue;
    }
    characters.push({
      id: character.id,
      dir: characterDir(character.id),
      assets: [
        ...toAssets('clip', character.id, character.clips),
        ...toAssets('sequence', character.id, character.sequences),
      ],
      drafts: await toDrafts(root, character.id, character.drafts),
      sequenceDrafts: await toDrafts(
        root,
        character.id,
        character.sequenceDrafts,
        sequenceDraftDir,
        sequenceDraftPath,
      ),
    });
  }

  return {
    root,
    recordings: tree.recordings.map((id) => ({ id, dir: recordingDir(id) })),
    characters,
    exports: tree.exports.map((target) => ({ target, dir: exportDir(target) })),
  };
}

/**
 * A folder under `drafts/` counts as a Draft only when it carries a descriptor —
 * the same "recognise by artifact" rule a Character follows for `canvas.json`.
 */
async function toDrafts(
  root: string,
  characterId: string,
  ids: string[],
  dirOf: (characterId: string, id: string) => string = draftDir,
  pathOf: (characterId: string, id: string) => string = draftPath,
): Promise<ScannedDraft[]> {
  const drafts: ScannedDraft[] = [];
  for (const id of ids) {
    if (await pathExists(root, pathOf(characterId, id))) {
      drafts.push({ id, dir: dirOf(characterId, id) });
    }
  }
  return drafts;
}

function toAssets(kind: ScannedAsset['kind'], characterId: string, ids: string[]): ScannedAsset[] {
  const dir = kind === 'clip' ? clipDir : sequenceDir;
  return ids.map((id) => ({ kind, id, dir: dir(characterId, id) }));
}
