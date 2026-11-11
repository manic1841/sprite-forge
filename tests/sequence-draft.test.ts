// Sequence drafts — the persisted recipe behind the Compose face.
//
// A composition belongs to its Character and may start before any Sequence
// exists. These tests drive the core verbs in-process and assert on the store.

import { describe, expect, it } from 'vitest';
import {
  commitDraft,
  createCharacter,
  extractClipDraft,
  ingestRecording,
  addSegment,
  listSequenceDrafts,
  readSequenceDraft,
  removeSequenceDraft,
  saveSequenceDraft,
  scan,
} from '../src/core/index.js';
import { withStore, type StoreFixture } from './harness.js';
import { withSyntheticGif } from './synthetic-gif.js';

const CHARACTER_ID = 'hero';

/** Seed a Character with one committed Clip (`red`). */
async function seedClip(store: StoreFixture, gif: { path: string }): Promise<void> {
  await createCharacter(store.root, {
    characterId: CHARACTER_ID,
    width: 4,
    height: 6,
    anchor: { x: 2, y: 6 },
  });
  await ingestRecording(store.root, { recordingId: 'red-rec', sourcePath: gif.path });
  await addSegment(store.root, {
    recordingId: 'red-rec',
    id: 'red',
    startFrame: 0,
    endFrame: 2,
  });
  await extractClipDraft(store.root, {
    characterId: CHARACTER_ID,
    recordingId: 'red-rec',
    cutId: 'red',
  });
  await commitDraft(store.root, { characterId: CHARACTER_ID, draftId: 'red', assetId: 'red-run' });
}

describe('sequence drafts', () => {
  it('saves a composition under the Character and reads it back', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedClip(store, gif);

        const saved = await saveSequenceDraft(store.root, {
          characterId: CHARACTER_ID,
          clips: ['red-run'],
          forkOf: 'greeting',
        });
        expect(saved.id).toBe('composition');
        expect(store.readJson('characters/hero/sequence-drafts/composition/draft.json')).toMatchObject(
          { id: 'composition', characterId: CHARACTER_ID, clips: ['red-run'], forkOf: 'greeting' },
        );

        const read = await readSequenceDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: 'composition',
        });
        expect(read.clips).toEqual(['red-run']);
      });
    });
  });

  it('starts empty and picks a free id rather than overwriting a composition', async () => {
    await withStore(async (store) => {
      await createCharacter(store.root, {
        characterId: CHARACTER_ID,
        width: 4,
        height: 6,
        anchor: { x: 2, y: 6 },
      });

      const first = await saveSequenceDraft(store.root, { characterId: CHARACTER_ID, clips: [] });
      const second = await saveSequenceDraft(store.root, { characterId: CHARACTER_ID, clips: [] });
      expect([first.id, second.id]).toEqual(['composition', 'composition-2']);
      expect(await listSequenceDrafts(store.root, CHARACTER_ID)).toEqual([
        'composition',
        'composition-2',
      ]);
    });
  });

  it('appears in the scan and can be removed', async () => {
    await withStore(async (store) => {
      await createCharacter(store.root, {
        characterId: CHARACTER_ID,
        width: 4,
        height: 6,
        anchor: { x: 2, y: 6 },
      });
      await saveSequenceDraft(store.root, { characterId: CHARACTER_ID, draftId: 'compo', clips: [] });

      const listed = await scan(store.root);
      expect(listed.characters[0]!.sequenceDrafts.map((draft) => draft.id)).toEqual(['compo']);

      await removeSequenceDraft(store.root, { characterId: CHARACTER_ID, draftId: 'compo' });
      expect(await listSequenceDrafts(store.root, CHARACTER_ID)).toEqual([]);
    });
  });

  it('refuses a Clip id that is not a committed Clip of the Character', async () => {
    await withStore(async (store) => {
      await createCharacter(store.root, {
        characterId: CHARACTER_ID,
        width: 4,
        height: 6,
        anchor: { x: 2, y: 6 },
      });
      await expect(
        saveSequenceDraft(store.root, { characterId: CHARACTER_ID, clips: ['nope'] }),
      ).rejects.toThrow(/nope/);
    });
  });
});
