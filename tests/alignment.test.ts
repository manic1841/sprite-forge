// Ticket #28 — Canvas alignment: the per-Clip manual `placementOffset` and the
// explicit Character-wide **expand canvas**.
//
// The seam is the core command surface, driven in-process against a temporary
// store. Tests assert on observable behaviour: the descriptor/provenance read
// back, the baked sheet's pixels and dimensions, the store left behind, and the
// validity warnings returned by the alignment/repair reads — never on module
// internals.
//
// Fixture geometry (from `tests/synthetic-gif.ts`, frames=2, width=8, height=6):
// on a 4x6 Canvas with Anchor (2,6), frame 0's opaque content is at Canvas
// (1,4,2,2) and frame 1's at (2,4,2,2). Committing tiles them into an 8x6 strip.

import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  addSegment,
  commitDraft,
  createCharacter,
  expandCanvas,
  extractClipDraft,
  forkAsset,
  ingestRecording,
  readDraftAlignment,
  readDraftRepair,
  setPlacementOffset,
  StoreError,
  validateStore,
} from '../src/core/index.js';
import { withStore, type StoreFixture } from './harness.js';
import { withSyntheticGif, type SyntheticGif } from './synthetic-gif.js';

const CHARACTER_ID = 'hero';
const RECORDING_ID = 'mgba-2026-09';
const CUT_ID = 'walk';
const DRAFT_ID = 'walk';
const ASSET_ID = 'walk-run';
const DRAFT_PATH = `characters/${CHARACTER_ID}/drafts/${DRAFT_ID}/draft.json`;

/** Seed a store with an ingested 2-frame Recording, a Segment and a Character. */
async function seed(gif: SyntheticGif, store: StoreFixture): Promise<void> {
  await ingestRecording(store.root, { recordingId: RECORDING_ID, sourcePath: gif.path });
  await addSegment(store.root, {
    recordingId: RECORDING_ID,
    id: CUT_ID,
    startFrame: 0,
    endFrame: 2,
  });
  await createCharacter(store.root, {
    characterId: CHARACTER_ID,
    width: 4,
    height: 6,
    anchor: { x: 2, y: 6 },
  });
}

/** Seed the standard Draft. */
async function extract(store: StoreFixture): Promise<void> {
  await extractClipDraft(store.root, {
    characterId: CHARACTER_ID,
    recordingId: RECORDING_ID,
    cutId: CUT_ID,
  });
}

/** Decode a PNG from the store into raw RGBA pixels. */
async function decode(
  store: StoreFixture,
  relPath: string,
): Promise<{ width: number; height: number; data: Buffer }> {
  const { data, info } = await sharp(path.join(store.root, relPath))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** The RGBA pixel of a decoded image at `(x, y)`. */
function pixel(
  image: { width: number; data: Buffer },
  x: number,
  y: number,
): [number, number, number, number] {
  const at = (y * image.width + x) * 4;
  return [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!, image.data[at + 3]!];
}

const SHEET = `characters/${CHARACTER_ID}/clips/${ASSET_ID}/sheet.png`;
const PROVENANCE = `characters/${CHARACTER_ID}/clips/${ASSET_ID}/provenance.json`;

describe('setPlacementOffset', () => {
  it('records a non-zero offset in the Draft, re-applied when the Clip is baked', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);

        const draft = await setPlacementOffset(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          offset: { x: 0, y: -1 },
        });
        expect(draft.placementOffset).toEqual({ x: 0, y: -1 });
        expect(store.readJson(DRAFT_PATH)).toMatchObject({ placementOffset: { x: 0, y: -1 } });

        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          assetId: ASSET_ID,
        });

        // The offset is re-applied at bake: frame 0's content moved up one pixel.
        const sheet = await decode(store, SHEET);
        expect(pixel(sheet, 1, 3)).toEqual([255, 0, 0, 255]); // moved into y=3
        expect(pixel(sheet, 1, 5)[3]).toBe(0); // vacated y=5
        // Frame 1 sits one Canvas width later (x +4), also one pixel up.
        expect(pixel(sheet, 4 + 2, 3)).toEqual([255, 0, 0, 255]);

        // Provenance records the offset and validates.
        expect(store.readJson(PROVENANCE)).toMatchObject({ placementOffset: { x: 0, y: -1 } });
        await expect(validateStore(store.root)).resolves.toBeDefined();
      });
    });
  });

  it('omits placementOffset from the Draft and provenance when {0,0}', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);

        // A non-zero offset then back to zero: the field is dropped.
        await setPlacementOffset(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          offset: { x: 1, y: 1 },
        });
        await setPlacementOffset(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          offset: { x: 0, y: 0 },
        });
        expect(store.readJson(DRAFT_PATH)).not.toHaveProperty('placementOffset');

        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          assetId: ASSET_ID,
        });
        expect(store.readJson(PROVENANCE)).not.toHaveProperty('placementOffset');
      });
    });
  });

  it('rejects a non-integer offset', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);
        await expect(
          setPlacementOffset(store.root, {
            characterId: CHARACTER_ID,
            draftId: DRAFT_ID,
            offset: { x: 0.5, y: 0 },
          }),
        ).rejects.toThrow(StoreError);
      });
    });
  });
});

describe('fork carries the placement offset', () => {
  it('copies the offset and re-applies it, reproducing the parent sheet', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);
        await setPlacementOffset(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          offset: { x: 0, y: -1 },
        });
        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          assetId: ASSET_ID,
        });
        const parentSheet = store.readText(SHEET);

        const fork = await forkAsset(store.root, {
          characterId: CHARACTER_ID,
          kind: 'clip',
          id: ASSET_ID,
        });
        expect(fork.placementOffset).toEqual({ x: 0, y: -1 });

        // The fork's Draft holds the automatic placement again; committing re-applies
        // the inherited offset, so the two sheets match pixel for pixel.
        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: ASSET_ID,
          assetId: 'walk-run-2',
        });
        expect(
          store.readJson(`characters/${CHARACTER_ID}/clips/walk-run-2/provenance.json`),
        ).toMatchObject({ placementOffset: { x: 0, y: -1 } });
        expect(store.readText(SHEET)).toBe(parentSheet);
        const forkSheet = await decode(store, `characters/${CHARACTER_ID}/clips/walk-run-2/sheet.png`);
        expect(pixel(forkSheet, 1, 3)).toEqual([255, 0, 0, 255]);
      });
    });
  });
});

describe('expandCanvas', () => {
  it('grows the Canvas symmetrically and re-bakes every committed Clip', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);
        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          assetId: ASSET_ID,
        });
        const before = await decode(store, SHEET);
        expect([before.width, before.height]).toEqual([8, 6]);

        const result = await expandCanvas(store.root, {
          characterId: CHARACTER_ID,
          width: 8,
          height: 10,
        });

        // The Anchor invariant still holds at the new size.
        expect(result.canvas).toEqual({ width: 8, height: 10, anchor: { x: 4, y: 10 } });
        expect(store.readJson(`characters/${CHARACTER_ID}/canvas.json`)).toEqual(result.canvas);

        // The committed Clip is re-baked: frames grow, content is re-placed by the
        // Anchor delta ((8-4)/2, 10-6) = (2, 4) and otherwise unchanged.
        const after = await decode(store, SHEET);
        expect([after.width, after.height]).toEqual([16, 10]);
        expect(pixel(after, 1 + 2, 4 + 4)).toEqual([255, 0, 0, 255]);
        expect(pixel(after, 8 + 2 + 2, 4 + 4)).toEqual([255, 0, 0, 255]);
        expect(result.rebakedClips).toEqual([ASSET_ID]);
        await expect(validateStore(store.root)).resolves.toBeDefined();
      });
    });
  });

  it('re-places Draft frames on the new Canvas and warns that alignment is stale', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);
        await setPlacementOffset(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          offset: { x: 0, y: -1 },
        });
        await appendRepair(store, { tool: 'erase-rect', geometry: { x: 1, y: 4, width: 1, height: 1 } });

        await expandCanvas(store.root, { characterId: CHARACTER_ID, width: 8, height: 10 });

        // The Draft's frames are the new Canvas size...
        const frame = await decode(store, `characters/${CHARACTER_ID}/drafts/${DRAFT_ID}/frames/000.png`);
        expect([frame.width, frame.height]).toEqual([8, 10]);

        // ...and both the alignment and the Repair script now warn (never silently
        // misapplied): both were authored against the old Canvas.
        const alignment = await readDraftAlignment(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
        });
        expect(alignment.warnings.map((w) => w.code)).toContain('alignment-framing-changed');
        const repair = await readDraftRepair(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
        });
        expect(repair.warnings.map((w) => w.code)).toContain('framing-changed');
      });
    });
  });

  it('warns for a committed Clip’s Repair script whose geometry the expand invalidated', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);
        await appendRepair(store, { tool: 'erase-rect', geometry: { x: 1, y: 4, width: 1, height: 1 } });
        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          assetId: ASSET_ID,
        });

        const result = await expandCanvas(store.root, {
          characterId: CHARACTER_ID,
          width: 8,
          height: 10,
        });
        expect(result.repairWarnings.map((w) => w.code)).toContain('framing-changed');
      });
    });
  });

  it('refuses to shrink the Canvas or break the symmetry invariant', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);

        await expect(
          expandCanvas(store.root, { characterId: CHARACTER_ID, width: 2, height: 10 }),
        ).rejects.toThrow(StoreError);
        await expect(
          expandCanvas(store.root, { characterId: CHARACTER_ID, width: 5, height: 10 }),
        ).rejects.toThrow(StoreError);

        // A rejected expand leaves the Canvas untouched and the Draft intact.
        expect(store.readJson(`characters/${CHARACTER_ID}/canvas.json`)).toEqual({
          width: 4,
          height: 6,
          anchor: { x: 2, y: 6 },
        });
        expect(store.listFiles()).toContain(DRAFT_PATH);
      });
    });
  });
});

describe('the content-too-large path stays explicit', () => {
  it('errors rather than silently growing when content does not fit', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await ingestRecording(store.root, { recordingId: RECORDING_ID, sourcePath: gif.path });
        await addSegment(store.root, {
          recordingId: RECORDING_ID,
          id: CUT_ID,
          startFrame: 0,
          endFrame: 2,
        });
        // A Canvas too small for the union crop (3x2) at the Anchor.
        await createCharacter(store.root, {
          characterId: CHARACTER_ID,
          width: 2,
          height: 4,
          anchor: { x: 1, y: 4 },
        });

        await expect(extract(store)).rejects.toThrow(StoreError);
        // Nothing was written: the Canvas was not grown as a side effect.
        expect(store.readJson(`characters/${CHARACTER_ID}/canvas.json`)).toEqual({
          width: 2,
          height: 4,
          anchor: { x: 1, y: 4 },
        });
      });
    });
  });
});

/** Append one Repair operation to the standard Draft. */
async function appendRepair(
  store: StoreFixture,
  operation: {
    tool: 'erase-rect';
    geometry: { x: number; y: number; width: number; height: number };
  },
): Promise<void> {
  const { appendRepairOperation } = await import('../src/core/index.js');
  await appendRepairOperation(store.root, {
    characterId: CHARACTER_ID,
    draftId: DRAFT_ID,
    operation: {
      tool: operation.tool,
      frames: { start: 0, end: 2 },
      geometry: operation.geometry,
    },
  });
}
