// Ticket #27 — Repair: hand-editing a de-backgrounded Clip as a replayable
// operation script.
//
// The seam is the core command surface, driven in-process against a temporary
// store. Tests assert on observable behaviour: the written `repair.json` and its
// schema validity, the replayed pixels, the committed sheet, and provenance —
// never on module internals.
//
// Fixture geometry (tests/synthetic-gif.ts, frames=2, width=8, height=6): on a
// 4x6 Canvas with Anchor (2,6), the first frame's opaque content is at canvas
// (1,4,2,2) and the second's at (2,4,2,2).

import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  addSegment,
  appendRepairOperation,
  commitDraft,
  createCharacter,
  extractClipDraft,
  forkAsset,
  ingestRecording,
  readClipDraft,
  readClipDraftFrame,
  readDraftRepair,
  readDraftRepairFrame,
  readRepairScript,
  undoRepairOperation,
  ValidationError,
  validateStore,
  StoreError,
} from '../src/core/index.js';
import type { RgbaImage } from '../src/core/background.js';
import { withStore, type StoreFixture } from './harness.js';
import { withSyntheticGif, type SyntheticGif } from './synthetic-gif.js';

const CHARACTER_ID = 'hero';
const RECORDING_ID = 'mgba-2026-09';
const CUT_ID = 'walk';
const DRAFT_ID = 'walk';
const ASSET_ID = 'walk-run';

/** Seed a store with an ingested 2-frame Recording, a Segment, a Character and its Draft. */
async function seedDraft(gif: SyntheticGif, store: StoreFixture): Promise<void> {
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
  await extractClipDraft(store.root, {
    characterId: CHARACTER_ID,
    recordingId: RECORDING_ID,
    cutId: CUT_ID,
  });
}

/** Decode a PNG (file or bytes) into a raw RGBA image. */
async function decodeImage(source: Buffer | string): Promise<RgbaImage> {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/** The RGBA pixel at `(x, y)` of a raw RGBA image. */
function pixel(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const at = (y * image.width + x) * 4;
  return [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!, image.data[at + 3]!];
}

const SCRIPT_PATH = `characters/${CHARACTER_ID}/repairs/${DRAFT_ID}/repair.json`;

describe('Repair operations and the script', () => {
  it('appends an erase-rect operation and writes a schema-valid script', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);

        const state = await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            tool: 'erase-rect',
            frames: { start: 0, end: 1 },
            geometry: { x: 1, y: 4, width: 2, height: 2 },
          },
        });

        expect(state.operations).toHaveLength(1);
        expect(state.operations[0]).toMatchObject({ tool: 'erase-rect' });

        const script = store.readJson(SCRIPT_PATH);
        expect(script).toEqual({
          operations: [
            {
              tool: 'erase-rect',
              frames: { start: 0, end: 1 },
              geometry: { x: 1, y: 4, width: 2, height: 2 },
            },
          ],
        });
        await expect(validateStore(store.root)).resolves.toBeDefined();
      });
    });
  });

  it('requires a colour for paint-brush and forbids one for the erase tools', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);
        const base = {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            frames: { start: 0, end: 1 },
            geometry: { points: [[1, 4]] as Array<[number, number]>, size: 1 },
          },
        };

        await expect(
          appendRepairOperation(store.root, {
            ...base,
            operation: { ...base.operation, tool: 'paint-brush' },
          }),
        ).rejects.toThrow(ValidationError);

        await expect(
          appendRepairOperation(store.root, {
            ...base,
            operation: { ...base.operation, tool: 'erase-brush', color: '#ff0000' },
          }),
        ).rejects.toThrow(ValidationError);

        // Nothing invalid was written.
        expect(store.listFiles()).not.toContain(SCRIPT_PATH);
      });
    });
  });
});

/** Read a Draft frame with the Repair script replayed, as a raw RGBA image. */
async function readRepaired(store: StoreFixture, index: number): Promise<RgbaImage> {
  const frame = await readDraftRepairFrame(store.root, {
    characterId: CHARACTER_ID,
    draftId: DRAFT_ID,
    index,
  });
  return decodeImage(frame.data);
}

describe('Replaying a Repair script', () => {
  it('erases a rectangle: those pixels become transparent, other frames untouched', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);
        await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            tool: 'erase-rect',
            frames: { start: 0, end: 1 },
            geometry: { x: 1, y: 4, width: 2, height: 2 },
          },
        });

        const frame0 = await readRepaired(store, 0);
        expect(pixel(frame0, 1, 4)).toEqual([255, 0, 0, 0]);
        expect(pixel(frame0, 2, 5)[3]).toBe(0);
        // Frame 1 is outside the half-open range, so it keeps its content.
        const frame1 = await readRepaired(store, 1);
        expect(pixel(frame1, 2, 4)).toEqual([255, 0, 0, 255]);
      });
    });
  });

  it('erases a brush stroke: the stamped pixels become transparent', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);
        await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            tool: 'erase-brush',
            frames: { start: 0, end: 1 },
            geometry: { points: [[2, 4]], size: 1 },
          },
        });

        const frame0 = await readRepaired(store, 0);
        expect(pixel(frame0, 2, 4)[3]).toBe(0);
        expect(pixel(frame0, 1, 4)[3]).toBe(255);
      });
    });
  });

  it('paints a brush stroke opaque at the given colour (binary alpha)', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);
        await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            tool: 'paint-brush',
            frames: { start: 0, end: 1 },
            geometry: { points: [[0, 0], [1, 0]], size: 1 },
            color: '#00ff00',
          },
        });

        const frame0 = await readRepaired(store, 0);
        // A stroke connects its points: (0,0) and (1,0) are both painted.
        expect(pixel(frame0, 0, 0)).toEqual([0, 255, 0, 255]);
        expect(pixel(frame0, 1, 0)).toEqual([0, 255, 0, 255]);
        // Painting existing content overwrites it, still opaque.
        expect(pixel(frame0, 0, 5)[3]).toBe(0);
      });
    });
  });

  it('targets the current frame by default and a whole span when asked', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);
        // Frame 0 only.
        await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            tool: 'erase-rect',
            frames: { start: 0, end: 1 },
            geometry: { x: 0, y: 0, width: 1, height: 1 },
          },
        });
        expect(pixel(await readRepaired(store, 0), 0, 0)[3]).toBe(0);
        expect(pixel(await readRepaired(store, 1), 0, 0)[3]).toBe(0);

        // Now a span over both frames, a different pixel.
        await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            tool: 'erase-rect',
            frames: { start: 0, end: 2 },
            geometry: { x: 3, y: 5, width: 1, height: 1 },
          },
        });
        expect(pixel(await readRepaired(store, 0), 3, 5)[3]).toBe(0);
        expect(pixel(await readRepaired(store, 1), 3, 5)[3]).toBe(0);
      });
    });
  });
});

describe('Undo and persistence', () => {
  it('undo removes the last operation and the replayed result reverts', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);
        await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            tool: 'erase-rect',
            frames: { start: 0, end: 1 },
            geometry: { x: 1, y: 4, width: 2, height: 2 },
          },
        });
        expect(pixel(await readRepaired(store, 0), 1, 4)[3]).toBe(0);

        const after = await undoRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
        });
        expect(after.operations).toEqual([]);
        expect(store.readJson(SCRIPT_PATH)).toEqual({ operations: [] });
        // The replayed frame reverts to its original content.
        expect(pixel(await readRepaired(store, 0), 1, 4)).toEqual([255, 0, 0, 255]);
      });
    });
  });

  it('writes the script on every operation and loses nothing on reload', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);
        await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            tool: 'erase-rect',
            frames: { start: 0, end: 1 },
            geometry: { x: 0, y: 0, width: 1, height: 1 },
          },
        });
        // Persisted immediately, not on some later flush.
        expect(
          (store.readJson(SCRIPT_PATH) as { operations: unknown[] }).operations,
        ).toHaveLength(1);

        await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            tool: 'paint-brush',
            frames: { start: 1, end: 2 },
            geometry: { points: [[0, 0]], size: 1 },
            color: '#0000ff',
          },
        });

        // A fresh read (as after a reload) resumes both operations in order.
        const script = await readRepairScript(store.root, {
          characterId: CHARACTER_ID,
          clipId: DRAFT_ID,
        });
        expect(script.operations.map((operation) => operation.tool)).toEqual([
          'erase-rect',
          'paint-brush',
        ]);
        const state = await readDraftRepair(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
        });
        expect(state.operations).toHaveLength(2);
      });
    });
  });
});

describe('Commit bakes the repaired result', () => {
  /** Seed → repair frame 0's content → commit. */
  async function repairAndCommit(store: StoreFixture): Promise<void> {
    await appendRepairOperation(store.root, {
      characterId: CHARACTER_ID,
      draftId: DRAFT_ID,
      operation: {
        tool: 'erase-rect',
        frames: { start: 0, end: 1 },
        geometry: { x: 1, y: 4, width: 2, height: 2 },
      },
    });
    await commitDraft(store.root, {
      characterId: CHARACTER_ID,
      draftId: DRAFT_ID,
      assetId: ASSET_ID,
    });
  }

  it('bakes the repaired frames into sheet.png', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);
        await repairAndCommit(store);

        const sheet = await decodeImage(
          path.join(store.root, `characters/${CHARACTER_ID}/clips/${ASSET_ID}/sheet.png`),
        );
        // Frame 0's erased content is transparent in the strip...
        expect(pixel(sheet, 1, 4)).toEqual([255, 0, 0, 0]);
        // ...while frame 1 (outside the range) stays opaque at sheet x = 4 + 2.
        expect(pixel(sheet, 6, 4)).toEqual([255, 0, 0, 255]);
      });
    });
  });

  it('re-homes the script onto the asset id and points provenance at it', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);
        await repairAndCommit(store);

        const rehomed = `characters/${CHARACTER_ID}/repairs/${ASSET_ID}/repair.json`;
        expect(store.listFiles()).toContain(rehomed);
        // The Draft id no longer owns the script.
        expect(store.listFiles()).not.toContain(SCRIPT_PATH);

        const provenance = store.readJson(
          `characters/${CHARACTER_ID}/clips/${ASSET_ID}/provenance.json`,
        ) as Record<string, unknown>;
        expect(provenance.repair).toBe(rehomed);
        await expect(validateStore(store.root)).resolves.toBeDefined();
      });
    });
  });
});

describe('Fork copies the parent Repair script', () => {
  it('starts the branch from the parent script and leaves the parent untouched', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);
        await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            tool: 'erase-rect',
            frames: { start: 0, end: 1 },
            geometry: { x: 1, y: 4, width: 2, height: 2 },
          },
        });
        await commitDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          assetId: ASSET_ID,
        });
        const parentScriptPath = `characters/${CHARACTER_ID}/repairs/${ASSET_ID}/repair.json`;
        const parentSheetPath = `characters/${CHARACTER_ID}/clips/${ASSET_ID}/sheet.png`;
        const parentScript = store.readText(parentScriptPath);
        const parentSheet = store.readText(parentSheetPath);

        await forkAsset(store.root, {
          characterId: CHARACTER_ID,
          kind: 'clip',
          id: ASSET_ID,
          draftId: 'branch',
        });

        const branchScriptPath = `characters/${CHARACTER_ID}/repairs/branch/repair.json`;
        expect(store.readText(branchScriptPath)).toBe(parentScript);

        // Repair the fork: only the branch's script changes.
        await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: 'branch',
          operation: {
            tool: 'paint-brush',
            frames: { start: 1, end: 2 },
            geometry: { points: [[0, 0]], size: 1 },
            color: '#0000ff',
          },
        });
        expect(
          (store.readJson(branchScriptPath) as { operations: unknown[] }).operations,
        ).toHaveLength(2);
        expect(store.readText(parentScriptPath)).toBe(parentScript);
        expect(store.readText(parentSheetPath)).toBe(parentSheet);
      });
    });
  });
});

describe('Repair validity (Rule 4.3)', () => {
  it('warns when the Canvas changes since the script was authored', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);
        await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            tool: 'erase-rect',
            frames: { start: 0, end: 1 },
            geometry: { x: 1, y: 4, width: 2, height: 2 },
          },
        });

        // The Character's Canvas is expanded (alignment work elsewhere, #28).
        store.writeJson(`characters/${CHARACTER_ID}/canvas.json`, {
          width: 8,
          height: 6,
          anchor: { x: 4, y: 6 },
        });

        const state = await readDraftRepair(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
        });
        expect(state.warnings.map((warning) => warning.code)).toContain('framing-changed');
      });
    });
  });

  it('warns when a re-cut leaves an operation targeting frames that no longer exist', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);
        // Target frame 1 explicitly.
        await appendRepairOperation(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          operation: {
            tool: 'erase-rect',
            frames: { start: 1, end: 2 },
            geometry: { x: 2, y: 4, width: 1, height: 1 },
          },
        });

        // Re-cut the Segment to one frame and re-extract the same Draft.
        await addSegment(store.root, {
          recordingId: RECORDING_ID,
          id: 'solo',
          startFrame: 0,
          endFrame: 1,
        });
        await extractClipDraft(store.root, {
          characterId: CHARACTER_ID,
          recordingId: RECORDING_ID,
          cutId: 'solo',
          draftId: DRAFT_ID,
        });

        const state = await readDraftRepair(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
        });
        expect(state.warnings.map((warning) => warning.code)).toContain('frames-out-of-range');

        // No silent misapplication: the surviving frame is replayed without error
        // and the out-of-range operation leaves it pixel-identical to the raw frame.
        const raw = await decodeImage(
          (await readClipDraftFrame(store.root, { characterId: CHARACTER_ID, draftId: DRAFT_ID, index: 0 })).data,
        );
        const replayed = await readRepaired(store, 0);
        expect(replayed.data).toEqual(raw.data);
      });
    });
  });
});
