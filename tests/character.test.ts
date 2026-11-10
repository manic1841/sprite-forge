import { describe, expect, it } from 'vitest';
import {
  addSegment,
  createCharacter,
  deriveAnchor,
  ingestRecording,
  scan,
  StoreError,
  validateArtifact,
  ValidationError,
  validateStore,
} from '../src/core/index.js';
import { withStore } from './harness.js';
import { withSyntheticGif } from './synthetic-gif.js';

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

describe('deriveAnchor', () => {
  it("derives the Anchor as the first frame's content-box bottom-centre, with a symmetric Canvas", async () => {
    // Fixture frame 0 content box = { x: 1, y: 3, w: 2, h: 2 }; bottom-centre = (2, 5).
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await ingestRecording(store.root, { recordingId: 'rec', sourcePath: gif.path });

        const derived = await deriveAnchor(store.root, { recordingId: 'rec' });

        expect(derived.frame).toBe(0);
        expect(derived.bounds).toEqual({ x: 1, y: 3, width: 2, height: 2 });
        expect(derived.anchor).toEqual({ x: 2, y: 5 });
        // The Canvas is derived to stay symmetric about the Anchor (Rule 3.1).
        expect(derived.canvas).toEqual({ width: 4, height: 5, anchor: { x: 2, y: 5 } });
        expect(derived.canvas.anchor.x).toBe(derived.canvas.width / 2);
        expect(derived.canvas.anchor.y).toBe(derived.canvas.height);

        // The derived Canvas is valid and directly usable to create a Character.
        validateArtifact('canvas', derived.canvas);
        const created = await createCharacter(store.root, {
          characterId: 'hero',
          ...derived.canvas,
        });
        expect(created.canvas).toEqual(derived.canvas);
      });
    });
  });

  it("uses a Segment's first frame as the Anchor and sizes the Canvas to the whole Segment", async () => {
    // Fixture frame 1 content box = { x: 2, y: 3, w: 2, h: 2 }; bottom-centre = (3, 5).
    // The Segment is [1, 3), and frame 2 shifts one pixel right, so the union box is
    // { x: 2, y: 3, w: 3, h: 2 }: the Canvas must hold that, not just frame 1.
    await withSyntheticGif({ frames: 4, width: 8, height: 6, delaysMs: [50, 50, 60, 50] }, async (gif) => {
      await withStore(async (store) => {
        await ingestRecording(store.root, { recordingId: 'rec', sourcePath: gif.path });
        await addSegment(store.root, {
          recordingId: 'rec',
          id: 'walk',
          startFrame: 1,
          endFrame: 3,
        });

        const derived = await deriveAnchor(store.root, { recordingId: 'rec', cutId: 'walk' });

        expect(derived.frame).toBe(1);
        expect(derived.bounds).toEqual({ x: 2, y: 3, width: 2, height: 2 });
        // Anchor at the Canvas bottom-centre, with the union box fully inside it.
        expect(derived.anchor).toEqual({ x: 2, y: 4 });
        expect(derived.canvas).toEqual({ width: 4, height: 4, anchor: { x: 2, y: 4 } });
      });
    });
  });
});
