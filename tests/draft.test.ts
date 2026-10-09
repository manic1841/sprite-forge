// Ticket #23 — extracting a Segment produces a Clip **Draft**.
//
// The seam is the core command surface, driven in-process against a temporary
// store. Tests assert on observable behaviour: the draft artifact tree, the
// decoded frames' pixels, and the descriptor read back after a reload — never on
// module internals.
//
// Fixture geometry (from `tests/synthetic-gif.ts`, frames=2, width=8, height=6):
//   frame 0 content box = { x: 1, y: 3, w: 2, h: 2 }  (foot base = (2, 5))
//   frame 1 content box = { x: 2, y: 3, w: 2, h: 2 }
//   union of content  = { x: 1, y: 3, w: 3, h: 2 }
// A Canvas 4x6 with Anchor (2, 6) fits the union crop exactly, and the automatic
// placement puts the union crop at canvas (1, 4) so frame 0's foot base sits on
// the Anchor.

import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  addSegment,
  createCharacter,
  extractClipDraft,
  ingestRecording,
  readClipDraft,
  readClipDraftFrame,
  StoreError,
  validateStore,
} from '../src/core/index.js';
import { withStore, type StoreFixture } from './harness.js';
import { withSyntheticGif, type SyntheticGif } from './synthetic-gif.js';

const CHARACTER_ID = 'hero';
const RECORDING_ID = 'mgba-2026-09';
const CUT_ID = 'walk';
const DRAFT_ID = 'walk';
const DRAFT_PATH = `characters/${CHARACTER_ID}/drafts/${DRAFT_ID}/draft.json`;

/** Seed a store with an ingested 2-frame Recording and a matching Character. */
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

/** Decode a draft frame PNG from the store into raw RGBA pixels. */
async function decodeFrame(
  store: StoreFixture,
  framePath: string,
): Promise<{ width: number; height: number; data: Buffer }> {
  const { data, info } = await sharp(path.join(store.root, framePath))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** The tight bounding box of a decoded frame's opaque pixels, or null when empty. */
function opaqueBounds(frame: {
  width: number;
  height: number;
  data: Buffer;
}): { x: number; y: number; width: number; height: number } | null {
  let minX = frame.width;
  let minY = frame.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      if (frame.data[(y * frame.width + x) * 4 + 3]! > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** The smallest box containing every box. */
function unionOf(boxes: Array<{ x: number; y: number; width: number; height: number }>): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

describe('extractClipDraft', () => {
  it('writes a Clip Draft that survives a reload', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);

        const draft = await extractClipDraft(store.root, {
          characterId: CHARACTER_ID,
          recordingId: RECORDING_ID,
          cutId: CUT_ID,
        });

        expect(draft).toMatchObject({
          id: DRAFT_ID,
          characterId: CHARACTER_ID,
          recordingId: RECORDING_ID,
          frameCount: 2,
          delaysMs: [50, 60],
          loop: true,
          background: { hex: '#9421ce', source: 'sampled', tolerance: 24 },
          segment: { cutId: CUT_ID, startFrame: 0, endFrame: 2, speed: 1 },
        });

        // The Draft is on disk: its descriptor plus one PNG per frame.
        expect(store.listFiles()).toContain(DRAFT_PATH);
        expect(store.listFiles()).toContain(
          `characters/${CHARACTER_ID}/drafts/${DRAFT_ID}/frames/000.png`,
        );
        expect(store.listFiles()).toContain(
          `characters/${CHARACTER_ID}/drafts/${DRAFT_ID}/frames/001.png`,
        );

        // A fresh read (the reload) resumes the same Draft.
        const reloaded = await readClipDraft(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
        });
        expect(reloaded.delaysMs).toEqual([50, 60]);
        expect(reloaded.frames).toEqual([
          `characters/${CHARACTER_ID}/drafts/${DRAFT_ID}/frames/000.png`,
          `characters/${CHARACTER_ID}/drafts/${DRAFT_ID}/frames/001.png`,
        ]);

        // Drafts are working state: they do not make the store invalid.
        await expect(validateStore(store.root)).resolves.toBeDefined();
      });
    });
  });

  it('de-backgrounds the frames to binary alpha', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);

        const draft = await extractClipDraft(store.root, {
          characterId: CHARACTER_ID,
          recordingId: RECORDING_ID,
          cutId: CUT_ID,
        });
        const frame = await decodeFrame(store, draft.frames[0]!);

        // Alpha is strictly binary — 0 or 255, never partial (research §3).
        const alphas = new Set<number>();
        for (let at = 3; at < frame.data.length; at += 4) {
          alphas.add(frame.data[at]!);
        }
        expect([...alphas].sort((a, b) => a - b)).toEqual([0, 255]);

        // The subject keeps its colour and becomes opaque...
        const subjectAt = (5 * frame.width + 1) * 4;
        expect([...frame.data.subarray(subjectAt, subjectAt + 4)]).toEqual([255, 0, 0, 255]);
        // ...while the keyed background is fully transparent.
        const cornerAt = 0;
        expect(frame.data[cornerAt + 3]).toBe(0);
      });
    });
  });

  it('samples the background colour from a corner of the frames', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], background: '#123456' },
      async (gif) => {
        await withStore(async (store) => {
          await seed(gif, store);

          const draft = await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: CUT_ID,
          });

          expect(draft.background).toEqual({
            hex: '#123456',
            source: 'sampled',
            tolerance: 24,
          });
          expect(store.readJson(DRAFT_PATH)).toMatchObject({
            background: { hex: '#123456', source: 'sampled', tolerance: 24 },
          });
        });
      },
    );
  });

  it('honours an explicit background override, normalising it to lowercase', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);

        const draft = await extractClipDraft(store.root, {
          characterId: CHARACTER_ID,
          recordingId: RECORDING_ID,
          cutId: CUT_ID,
          background: '#9421CE',
          tolerance: 7,
        });

        expect(draft.background).toEqual({
          hex: '#9421ce',
          source: 'override',
          tolerance: 7,
        });

        // The override colour is the one keyed: the backdrop is transparent.
        const frame = await decodeFrame(store, draft.frames[0]!);
        expect(frame.data[3]).toBe(0);
        const subjectAt = (5 * frame.width + 1) * 4;
        expect(frame.data[subjectAt + 3]).toBe(255);
      });
    });
  });

  it('crops the frames to the union of content bounds', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);

        const draft = await extractClipDraft(store.root, {
          characterId: CHARACTER_ID,
          recordingId: RECORDING_ID,
          cutId: CUT_ID,
        });
        const frames = await Promise.all(draft.frames.map((frame) => decodeFrame(store, frame)));

        // Each frame's painted content is exactly its own content box, placed at
        // the crop's position on the Canvas — no dead margin survives.
        expect(opaqueBounds(frames[0]!)).toEqual({ x: 1, y: 4, width: 2, height: 2 });
        expect(opaqueBounds(frames[1]!)).toEqual({ x: 2, y: 4, width: 2, height: 2 });

        const union = unionOf(frames.map((frame) => opaqueBounds(frame)!));
        expect(union).toEqual({ x: 1, y: 4, width: 3, height: 2 });

        // Cropping plus keying leaves no background colour anywhere: every opaque
        // pixel is the subject's colour.
        for (const frame of frames) {
          for (let at = 0; at < frame.data.length; at += 4) {
            if (frame.data[at + 3]! > 0) {
              expect([...frame.data.subarray(at, at + 3)]).toEqual([255, 0, 0]);
            }
          }
        }
      });
    });
  });

  it('places the frames on the Character Canvas via the Anchor', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);

        const draft = await extractClipDraft(store.root, {
          characterId: CHARACTER_ID,
          recordingId: RECORDING_ID,
          cutId: CUT_ID,
        });

        // Every frame is exactly the Character's Canvas — a Clip never has its own size.
        for (const framePath of draft.frames) {
          const frame = await decodeFrame(store, framePath);
          expect([frame.width, frame.height]).toEqual([4, 6]);
        }

        // The first frame's content-box bottom-centre (foot base) lands on the Anchor.
        const first = opaqueBounds(await decodeFrame(store, draft.frames[0]!))!;
        expect(first.x + first.width / 2).toBe(2);
        expect(first.y + first.height).toBe(6);
      });
    });
  });

  it('does not persist a frame size on the Draft', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);

        await extractClipDraft(store.root, {
          characterId: CHARACTER_ID,
          recordingId: RECORDING_ID,
          cutId: CUT_ID,
        });

        const descriptor = store.readJson(DRAFT_PATH) as Record<string, unknown>;
        for (const key of ['width', 'height', 'frameWidth', 'frameHeight', 'frameSize']) {
          expect(descriptor).not.toHaveProperty(key);
        }
      });
    });
  });

  it('reads the delays of the Segment, offset by its start frame', async () => {
    await withSyntheticGif(
      { frames: 4, width: 8, height: 6, delaysMs: [50, 50, 60, 50] },
      async (gif) => {
        await withStore(async (store) => {
          await ingestRecording(store.root, { recordingId: RECORDING_ID, sourcePath: gif.path });
          await addSegment(store.root, {
            recordingId: RECORDING_ID,
            id: CUT_ID,
            startFrame: 1,
            endFrame: 3,
          });
          await createCharacter(store.root, {
            characterId: CHARACTER_ID,
            width: 4,
            height: 6,
            anchor: { x: 2, y: 6 },
          });

          const draft = await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: CUT_ID,
          });

          expect(draft.delaysMs).toEqual([50, 60]);
          expect(draft.frameCount).toBe(2);
          // Placement uses the first frame *of the Segment*, not of the source.
          const first = opaqueBounds(await decodeFrame(store, draft.frames[0]!))!;
          expect(first.x + first.width / 2).toBe(2);
          expect(first.y + first.height).toBe(6);
        });
      },
    );
  });

  it('applies the Segment speed to the Clip delays without moving the range', async () => {
    await withSyntheticGif(
      { frames: 4, width: 8, height: 6, delaysMs: [50, 60, 80, 100] },
      async (gif) => {
        await withStore(async (store) => {
          await ingestRecording(store.root, { recordingId: RECORDING_ID, sourcePath: gif.path });
          await addSegment(store.root, {
            recordingId: RECORDING_ID,
            id: CUT_ID,
            startFrame: 1,
            endFrame: 3,
            speed: 2,
          });
          await createCharacter(store.root, {
            characterId: CHARACTER_ID,
            width: 4,
            height: 6,
            anchor: { x: 2, y: 6 },
          });

          const draft = await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: CUT_ID,
          });

          // `speed` is a playback multiplier: 2 plays twice as fast, halving each
          // frame's duration. It is applied when the Clip is generated.
          expect(draft.delaysMs).toEqual([30, 40]);
          // The Segment's frame *range* is untouched by `speed`.
          expect(draft.frameCount).toBe(2);
          expect(draft.segment).toEqual({
            cutId: CUT_ID,
            startFrame: 1,
            endFrame: 3,
            speed: 2,
          });
        });
      },
    );
  });

  it('rounds a sped-up delay and clamps it to at least 1ms', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [10, 20] },
      async (gif) => {
        await withStore(async (store) => {
          await ingestRecording(store.root, { recordingId: RECORDING_ID, sourcePath: gif.path });
          await addSegment(store.root, {
            recordingId: RECORDING_ID,
            id: CUT_ID,
            startFrame: 0,
            endFrame: 2,
            speed: 3,
          });
          await createCharacter(store.root, {
            characterId: CHARACTER_ID,
            width: 4,
            height: 6,
            anchor: { x: 2, y: 6 },
          });

          const draft = await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: CUT_ID,
          });

          // 10/3 -> 3, 20/3 -> 7: rounded to the nearest integer millisecond.
          expect(draft.delaysMs).toEqual([3, 7]);
          expect(draft.delaysMs.every((delay) => delay >= 1)).toBe(true);
        });
      },
    );
  });
});

describe('extractClipDraft failures', () => {
  it('is a hard error for an unknown cut id and writes nothing', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);

        await expect(
          extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: 'jump',
          }),
        ).rejects.toThrow(StoreError);
        expect(store.listFiles()).not.toContain(DRAFT_PATH);
      });
    });
  });

  it('is a hard error when the content does not fit the Canvas', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
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
          width: 2,
          height: 6,
          anchor: { x: 1, y: 6 },
        });

        await expect(
          extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: CUT_ID,
          }),
        ).rejects.toThrow(/does not fit .* Canvas/i);
      });
    });
  });

  it('is a hard error when the source no longer matches its recorded hash', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seed(gif, store);
        store.writeFile(`recordings/${RECORDING_ID}/source.gif`, 'not the ingested bytes');

        await expect(
          extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: CUT_ID,
          }),
        ).rejects.toThrow(/recorded hash/i);
      });
    });
  });
});

describe('readClipDraft', () => {
  it('is a hard error when the Draft does not exist', async () => {
    await withStore(async (store) => {
      await expect(
        readClipDraft(store.root, { characterId: CHARACTER_ID, draftId: DRAFT_ID }),
      ).rejects.toThrow(StoreError);
    });
  });
});

describe('readClipDraftFrame', () => {
  /** Extract the standard 2-frame Draft and return its store. */
  async function seedDraft(
    gif: SyntheticGif,
    store: StoreFixture,
  ): Promise<void> {
    await seed(gif, store);
    await extractClipDraft(store.root, {
      characterId: CHARACTER_ID,
      recordingId: RECORDING_ID,
      cutId: CUT_ID,
    });
  }

  it('reads one frame as PNG bytes for a front end to display', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);

        const frame = await readClipDraftFrame(store.root, {
          characterId: CHARACTER_ID,
          draftId: DRAFT_ID,
          index: 1,
        });

        expect(frame.path).toBe(`characters/${CHARACTER_ID}/drafts/${DRAFT_ID}/frames/001.png`);
        expect(frame.contentType).toBe('image/png');
        // A real PNG the browser can render: signature + the Canvas frame size.
        expect([...frame.data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        const meta = await sharp(frame.data).metadata();
        expect([meta.width, meta.height]).toEqual([4, 6]);
      });
    });
  });

  it('is a hard error for an index outside the Draft', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (gif) => {
      await withStore(async (store) => {
        await seedDraft(gif, store);

        await expect(
          readClipDraftFrame(store.root, {
            characterId: CHARACTER_ID,
            draftId: DRAFT_ID,
            index: 2,
          }),
        ).rejects.toThrow(StoreError);
        await expect(
          readClipDraftFrame(store.root, {
            characterId: CHARACTER_ID,
            draftId: DRAFT_ID,
            index: -1,
          }),
        ).rejects.toThrow(StoreError);
      });
    });
  });
});
