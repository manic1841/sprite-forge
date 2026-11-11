// Ticket #24 — commit a Draft into an immutable Asset, and fork an Asset.
//
// The seam is the core command surface, driven in-process against a temporary
// store. Tests assert on observable behaviour: the committed artifact tree and
// its schema validity, the baked strip's dimensions and pixel order, provenance
// snapshots, and the store left behind after a fork — never on module internals.
//
// Fixture geometry (same as ticket #23, `tests/synthetic-gif.ts`, frames=2,
// width=8, height=6): on a 4x6 Canvas with Anchor (2,6), the first frame's opaque
// content is at canvas (1,4,2,2) and the second's at (2,4,2,2). Committing tiles
// them into an 8x6 strip, so frame 0 occupies sheet x[0,4) and frame 1 x[4,8).

import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  addSegment,
  commitDraft,
  createCharacter,
  extractClipDraft,
  forkAsset,
  ingestRecording,
  removeSegment,
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

/** Extract the standard Draft from a seeded store. */
async function extract(store: StoreFixture): Promise<void> {
  await extractClipDraft(store.root, {
    characterId: CHARACTER_ID,
    recordingId: RECORDING_ID,
    cutId: CUT_ID,
  });
}

/** Decode a PNG file from the store into raw RGBA pixels. */
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

describe('commitDraft', () => {
  it('bakes a Draft into clips/<id>/ and removes the Draft', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);

        const committed = await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          assetId: ASSET_ID,
        });

        expect(committed).toMatchObject({ kind: 'clip', id: ASSET_ID });
        expect(store.listFiles()).toEqual(
          expect.arrayContaining([
            `characters/${CHARACTER_ID}/clips/${ASSET_ID}/sheet.png`,
            `characters/${CHARACTER_ID}/clips/${ASSET_ID}/meta.json`,
            `characters/${CHARACTER_ID}/clips/${ASSET_ID}/provenance.json`,
          ]),
        );

        // The Draft is gone after a successful commit.
        expect(store.listFiles().some((file) => file.includes('/drafts/'))).toBe(false);

        // The committed Asset validates, and the store as a whole is valid.
        expect(store.readJson(`characters/${CHARACTER_ID}/clips/${ASSET_ID}/meta.json`)).toEqual({
          id: ASSET_ID,
          frameCount: 2,
          delaysMs: [50, 60],
          loop: true,
        });
        await expect(validateStore(store.root)).resolves.toBeDefined();
      });
    });
  });

  it('tiles the frames left to right into a Canvas-sized strip', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);
        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          assetId: ASSET_ID,
        });

        const sheet = await decode(store, `characters/${CHARACTER_ID}/clips/${ASSET_ID}/sheet.png`);
        // frameCount (2) frames of canvas.width (4) x canvas.height (6), left to right.
        expect([sheet.width, sheet.height]).toEqual([8, 6]);

        // Frame 0's content sits in the first canvas cell...
        expect(pixel(sheet, 1, 4)).toEqual([255, 0, 0, 255]);
        // ...frame 1's in the second, offset by one canvas width.
        expect(pixel(sheet, 4 + 2, 4)).toEqual([255, 0, 0, 255]);
        // The keyed background stays transparent.
        expect(pixel(sheet, 0, 0)[3]).toBe(0);
      });
    });
  });

  it('records provenance that snapshots the resolved Segment', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);
        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          assetId: ASSET_ID,
        });

        const provenance = store.readJson(
          `characters/${CHARACTER_ID}/clips/${ASSET_ID}/provenance.json`,
        ) as Record<string, unknown>;
        expect(provenance).toMatchObject({
          recordingId: RECORDING_ID,
          segment: { cutId: CUT_ID, startFrame: 0, endFrame: 2, speed: 1 },
          background: { hex: '#9421ce', source: 'sampled', tolerance: 24 },
          repair: null,
          derivedFrom: null,
        });
        expect(typeof provenance.recordingHash).toBe('string');
        expect(typeof provenance.spriteForgeVersion).toBe('string');
        // placementOffset is omitted when {0,0}.
        expect(provenance).not.toHaveProperty('placementOffset');
      });
    });
  });

  it('requires an id and enforces the id grammar', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);

        await expect(
          commitDraft(store.root, {
            characterId: CHARACTER_ID,
            draftId: DRAFT_ID,
            assetId: '',
          }),
        ).rejects.toThrow(StoreError);
        await expect(
          commitDraft(store.root, {
            characterId: CHARACTER_ID,
            draftId: DRAFT_ID,
            assetId: 'Walk Run',
          }),
        ).rejects.toThrow(StoreError);

        // A rejected commit leaves the Draft intact.
        expect(store.listFiles()).toContain(
          `characters/${CHARACTER_ID}/drafts/${DRAFT_ID}/draft.json`,
        );
      });
    });
  });

  it('refuses an id already held by a Sequence (one shared namespace)', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);
        // A Sequence with the wanted id already occupies the shared namespace.
        store.mkdir(`characters/${CHARACTER_ID}/sequences/${ASSET_ID}`);

        await expect(
          commitDraft(store.root, {
            characterId: CHARACTER_ID,
            draftId: DRAFT_ID,
            assetId: ASSET_ID,
          }),
        ).rejects.toThrow(StoreError);
        expect(store.listFiles()).toContain(
          `characters/${CHARACTER_ID}/drafts/${DRAFT_ID}/draft.json`,
        );
      });
    });
  });

  it('never overwrites a committed Asset (immutability)', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        await extract(store);
        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          assetId: ASSET_ID,
        });
        const sheetRel = `characters/${CHARACTER_ID}/clips/${ASSET_ID}/sheet.png`;
        const original = store.readText(sheetRel);

        // Re-extract the same Draft and try to commit over the existing Asset.
        await extract(store);
        await expect(
          commitDraft(store.root, {
            characterId: CHARACTER_ID,
            draftId: DRAFT_ID,
            assetId: ASSET_ID,
          }),
        ).rejects.toThrow(StoreError);

        expect(store.readText(sheetRel)).toBe(original);
      });
    });
  });

  it('still reproduces after its cut list is edited (snapshot, not pointer)', async () => {
    await withSyntheticGif({ frames: 4, width: 8, height: 6, delaysMs: [50, 50, 60, 50] }, async (gif) => {
      await withStore(async (store) => {
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
        await extract(store);
        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          assetId: ASSET_ID,
        });
        const sheetRel = `characters/${CHARACTER_ID}/clips/${ASSET_ID}/sheet.png`;
        const provenanceRel = `characters/${CHARACTER_ID}/clips/${ASSET_ID}/provenance.json`;
        const sheetBefore = store.readText(sheetRel);
        const provenanceBefore = store.readText(provenanceRel);

        // Re-cut: retarget the Segment the Clip came from.
        await removeSegment(store.root, { recordingId: RECORDING_ID, id: CUT_ID });
        await addSegment(store.root, {
          recordingId: RECORDING_ID,
          id: CUT_ID,
          startFrame: 1,
          endFrame: 4,
        });

        // The committed Clip is untouched: same sheet, same Segment snapshot.
        expect(store.readText(sheetRel)).toBe(sheetBefore);
        expect(store.readText(provenanceRel)).toBe(provenanceBefore);
        expect(store.readJson(provenanceRel)).toMatchObject({
          segment: { cutId: CUT_ID, startFrame: 0, endFrame: 2, speed: 1 },
        });
        await expect(validateStore(store.root)).resolves.toBeDefined();
      });
    });
  });
});

/** Seed → extract → commit the standard Clip; returns the committed Asset id. */
async function commitStandardClip(gif: SyntheticGif, store: StoreFixture): Promise<void> {
  await seed(gif, store);
  await extract(store);
  await commitDraft(store.root, {
    characterId: CHARACTER_ID,
    draftId: DRAFT_ID,
    assetId: ASSET_ID,
  });
}

describe('forkAsset', () => {
  it('opens an Asset as a Draft; committing records lineage and keeps the original', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await commitStandardClip(gif, store);
        const originalSheet = store.readText(
          `characters/${CHARACTER_ID}/clips/${ASSET_ID}/sheet.png`,
        );
        const originalProvenance = store.readText(
          `characters/${CHARACTER_ID}/clips/${ASSET_ID}/provenance.json`,
        );

        const draft = await forkAsset(store.root, {
          characterId: CHARACTER_ID,
          kind: 'clip',
          id: ASSET_ID,
        });

        expect(draft).toMatchObject({
          id: ASSET_ID,
          characterId: CHARACTER_ID,
          recordingId: RECORDING_ID,
          frameCount: 2,
          delaysMs: [50, 60],
          loop: true,
          segment: { cutId: CUT_ID, startFrame: 0, endFrame: 2, speed: 1 },
          derivedFrom: { kind: 'clip', id: ASSET_ID },
        });
        expect(store.listFiles()).toContain(
          `characters/${CHARACTER_ID}/drafts/${ASSET_ID}/frames/000.png`,
        );

        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: ASSET_ID,
          assetId: 'walk-run-2',
        });

        const provenance = store.readJson(
          `characters/${CHARACTER_ID}/clips/walk-run-2/provenance.json`,
        );
        expect(provenance).toMatchObject({ derivedFrom: { kind: 'clip', id: ASSET_ID } });

        // The original is kept, byte for byte.
        expect(store.readText(`characters/${CHARACTER_ID}/clips/${ASSET_ID}/sheet.png`)).toBe(
          originalSheet,
        );
        expect(store.readText(`characters/${CHARACTER_ID}/clips/${ASSET_ID}/provenance.json`)).toBe(
          originalProvenance,
        );
        await expect(validateStore(store.root)).resolves.toBeDefined();
      });
    });
  });

  it('inherits the parent’s placement offset', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await commitStandardClip(gif, store);
        // Give the parent a manual placement offset (docs/alignment.md).
        const provenanceRel = `characters/${CHARACTER_ID}/clips/${ASSET_ID}/provenance.json`;
        const parent = store.readJson(provenanceRel) as Record<string, unknown>;
        parent.placementOffset = { x: 0, y: -2 };
        store.writeJson(provenanceRel, parent);

        const draft = await forkAsset(store.root, {
          characterId: CHARACTER_ID,
          kind: 'clip',
          id: ASSET_ID,
        });
        expect(draft.placementOffset).toEqual({ x: 0, y: -2 });

        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: ASSET_ID,
          assetId: 'walk-run-2',
        });
        expect(
          store.readJson(`characters/${CHARACTER_ID}/clips/walk-run-2/provenance.json`),
        ).toMatchObject({ placementOffset: { x: 0, y: -2 } });
      });
    });
  });

  it('carries the parent’s Repair-script reference re-homed onto the new Clip (fork seam)', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await commitStandardClip(gif, store);
        const provenanceRel = `characters/${CHARACTER_ID}/clips/${ASSET_ID}/provenance.json`;
        const parent = store.readJson(provenanceRel) as Record<string, unknown>;
        parent.repair = `repairs/${ASSET_ID}/repair.json`;
        store.writeJson(provenanceRel, parent);

        const draft = await forkAsset(store.root, {
          characterId: CHARACTER_ID,
          kind: 'clip',
          id: ASSET_ID,
        });
        // The Draft carries the parent's script reference; commit re-homes it.
        expect(draft.repair).toBe(`repairs/${ASSET_ID}/repair.json`);

        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: ASSET_ID,
          assetId: 'walk-run-2',
        });
        expect(
          store.readJson(`characters/${CHARACTER_ID}/clips/walk-run-2/provenance.json`),
        ).toMatchObject({
          repair: `characters/${CHARACTER_ID}/repairs/walk-run-2/repair.json`,
        });
      });
    });
  });

  it('is a hard error for an unknown Asset or a bad id', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await commitStandardClip(gif, store);

        await expect(
          forkAsset(store.root, { characterId: CHARACTER_ID, kind: 'clip', id: 'missing' }),
        ).rejects.toThrow(StoreError);
        await expect(
          forkAsset(store.root, { characterId: CHARACTER_ID, kind: 'clip', id: 'Bad Id' }),
        ).rejects.toThrow(StoreError);
      });
    });
  });

  it('refuses to commit a Draft as a Sequence (Sequences come from Clips, not a Draft)', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await commitStandardClip(gif, store);
        await extract(store);

        // A Sequence is committed from an ordered Clip list via `commitSequence`;
        // `commitDraft` only ever bakes a Draft into a Clip.
        await expect(
          commitDraft(store.root, {
            characterId: CHARACTER_ID,
            draftId: DRAFT_ID,
            assetId: 'combo',
            kind: 'sequence',
          }),
        ).rejects.toThrow(/commitSequence/);
        await expect(
          forkAsset(store.root, { characterId: CHARACTER_ID, kind: 'sequence', id: 'missing' }),
        ).rejects.toThrow(StoreError);
      });
    });
  });
});
