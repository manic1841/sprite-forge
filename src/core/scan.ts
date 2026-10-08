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
  characterDir,
  clipDir,
  exportDir,
  recordingDir,
  sequenceDir,
} from './layout.js';
import { isDirectory, listDirectories } from './store/index.js';
import type { ScannedAsset, StoreScan } from './types.js';

/** A Character as found on disk, before it is shaped into a scan result. */
export interface CharacterTree {
  id: string;
  clips: string[];
  sequences: string[];
  repairs: string[];
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
    });
  }
  const exports = await listDirectories(root, EXPORTS_DIR);

  return { recordings, characters, exports };
}

/** List the store's Recordings, Characters (with committed Assets) and Exports. */
export async function scan(root: string): Promise<StoreScan> {
  const tree = await readStoreTree(root);

  return {
    root,
    recordings: tree.recordings.map((id) => ({ id, dir: recordingDir(id) })),
    characters: tree.characters.map((character) => ({
      id: character.id,
      dir: characterDir(character.id),
      assets: [
        ...toAssets('clip', character.id, character.clips),
        ...toAssets('sequence', character.id, character.sequences),
      ],
    })),
    exports: tree.exports.map((target) => ({ target, dir: exportDir(target) })),
  };
}

function toAssets(kind: ScannedAsset['kind'], characterId: string, ids: string[]): ScannedAsset[] {
  const dir = kind === 'clip' ? clipDir : sequenceDir;
  return ids.map((id) => ({ kind, id, dir: dir(characterId, id) }));
}
