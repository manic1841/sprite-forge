import { describe, expect, it } from 'vitest';
import {
  createCharacter,
  scan,
  StoreError,
  validateArtifact,
  ValidationError,
  validateStore,
} from '../src/core/index.js';
import { withStore } from './harness.js';

describe('createCharacter', () => {
  it('writes the Character canvas artifact at characters/<id>/canvas.json', async () => {
    await withStore(async (store) => {
      const created = await createCharacter(store.root, {
        characterId: 'hero',
        width: 60,
        height: 84,
        anchor: { x: 30, y: 84 },
      });

      expect(created).toEqual({
        id: 'hero',
        dir: 'characters/hero',
        canvas: { width: 60, height: 84, anchor: { x: 30, y: 84 } },
      });
      expect(store.readJson('characters/hero/canvas.json')).toEqual({
        width: 60,
        height: 84,
        anchor: { x: 30, y: 84 },
      });

      // The written artifact satisfies the frozen schema + the Anchor invariant.
      validateArtifact('canvas', store.readJson('characters/hero/canvas.json'));
      await expect(validateStore(store.root)).resolves.toBeDefined();
    });
  });

  it('rejects an Anchor whose x is not width/2, writing nothing', async () => {
    await withStore(async (store) => {
      await expect(
        createCharacter(store.root, {
          characterId: 'hero',
          width: 60,
          height: 84,
          anchor: { x: 31, y: 84 },
        }),
      ).rejects.toThrow(ValidationError);
      expect(store.listFiles()).toEqual([]);
    });
  });

  it('rejects an Anchor whose y is not height, writing nothing', async () => {
    await withStore(async (store) => {
      await expect(
        createCharacter(store.root, {
          characterId: 'hero',
          width: 60,
          height: 84,
          anchor: { x: 30, y: 83 },
        }),
      ).rejects.toThrow(ValidationError);
      expect(store.listFiles()).toEqual([]);
    });
  });

  it('rejects an odd width (no integer centre) with a clear error, writing nothing', async () => {
    await withStore(async (store) => {
      const failure = await createCharacter(store.root, {
        characterId: 'hero',
        width: 61,
        height: 84,
        anchor: { x: 30, y: 84 },
      }).catch((error) => error);
      expect(failure).toBeInstanceOf(StoreError);
      expect((failure as Error).message).toMatch(/even integer/i);
      expect(store.listFiles()).toEqual([]);
    });
  });

  it('rejects an invalid character id before writing anything', async () => {
    await withStore(async (store) => {
      await expect(
        createCharacter(store.root, {
          characterId: 'Hero',
          width: 60,
          height: 84,
          anchor: { x: 30, y: 84 },
        }),
      ).rejects.toThrow(StoreError);
      expect(store.listFiles()).toEqual([]);
    });
  });

  it('makes the Character appear in scan, recognised by its canvas.json', async () => {
    await withStore(async (store) => {
      await createCharacter(store.root, {
        characterId: 'hero',
        width: 60,
        height: 84,
        anchor: { x: 30, y: 84 },
      });

      // A bare folder with no canvas.json is not a Character.
      store.mkdir('characters/orphan');

      const tree = await scan(store.root);
      expect(tree.characters.map((c) => c.id)).toEqual(['hero']);
      expect(tree.characters[0]?.dir).toBe('characters/hero');
    });
  });
});
