// Ticket #29 — compose and commit a Sequence.
//
// The seam is the core command surface, driven in-process against a temporary
// store. Tests assert on observable behaviour: the committed artifact tree and
// its schema validity, the baked concatenated strip's dimensions and order,
// provenance, and immutability — never on module internals.
//
// Fixture: a 4x6 Canvas, Anchor (2,6). Two committed Clips come from two
// recordings with distinct foreground colours (red, green) so frame order across
// the concatenation boundary is directly observable. Each Clip is 2 frames, so a
// Clip's sheet is 8x6 and a Sequence of the two is 16x6.

import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import {
  addSegment,
  commitDraft,
  commitSequence,
  createCharacter,
  resizeCanvas,
  extractClipDraft,
  forkAsset,
  ingestRecording,
  StoreError,
  validateStore,
} from '../src/core/index.js';
import { withStore, type StoreFixture } from './harness.js';
import { withSyntheticGif, type SyntheticGif } from './synthetic-gif.js';

const CHARACTER_ID = 'hero';
const RED_RECORDING = 'rec-red';
const GREEN_RECORDING = 'rec-green';
const RED_CLIP = 'red-run';
const GREEN_CLIP = 'green-run';
const SEQUENCE_ID = 'combo';

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

/** Seed a Character and commit one 2-frame Clip per recording. */
async function seedClips(
  red: SyntheticGif,
  green: SyntheticGif,
  store: StoreFixture,
): Promise<void> {
  await createCharacter(store.root, {
    characterId: CHARACTER_ID,
    width: 4,
    height: 6,
    anchor: { x: 2, y: 6 },
  });
  for (const [recordingId, cutId, gif] of [
    [RED_RECORDING, 'red', red],
    [GREEN_RECORDING, 'green', green],
  ] as const) {
    await ingestRecording(store.root, { recordingId, sourcePath: gif.path });
    await addSegment(store.root, { recordingId, id: cutId, startFrame: 0, endFrame: 2 });
    await extractClipDraft(store.root, { characterId: CHARACTER_ID, recordingId, cutId });
    await commitDraft(store.root, {
      characterId: CHARACTER_ID,
      draftId: cutId,
      assetId: cutId === 'red' ? RED_CLIP : GREEN_CLIP,
    });
  }
}

describe('commitSequence', () => {
  it('commits an ordered list of Clips into sequences/<id>/ and validates', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);

          const committed = await commitSequence(store.root, {
            characterId: CHARACTER_ID,
            sequenceId: SEQUENCE_ID,
            clips: [RED_CLIP, GREEN_CLIP],
          });

          expect(committed).toMatchObject({ kind: 'sequence', id: SEQUENCE_ID });
          expect(store.listFiles()).toEqual(
            expect.arrayContaining([
              `characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/sheet.png`,
              `characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/meta.json`,
              `characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/provenance.json`,
            ]),
          );

          // Provenance lists the source Clip ids in order (format-spec §7).
          expect(
            store.readJson(
              `characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/provenance.json`,
            ),
          ).toMatchObject({
            clips: [RED_CLIP, GREEN_CLIP],
            derivedFrom: null,
          });
          await expect(validateStore(store.root)).resolves.toBeDefined();
        });
      });
    });
  });

  it('concatenates the Clips’ strips end to end, in the listed order', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);
          await commitSequence(store.root, {
            characterId: CHARACTER_ID,
            sequenceId: SEQUENCE_ID,
            clips: [RED_CLIP, GREEN_CLIP],
          });

          const sheet = await decode(store, `characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/sheet.png`);
          // 2 Clips x 2 frames x canvas.width (4) wide, canvas.height (6) tall.
          expect([sheet.width, sheet.height]).toEqual([16, 6]);
          // The red Clip occupies the first half, the green the second — order matters.
          expect(pixel(sheet, 1, 4)).toEqual([255, 0, 0, 255]);
          expect(pixel(sheet, 9, 4)).toEqual([0, 255, 0, 255]);

          // The strip is exactly the two source strips laid side by side.
          const redSheet = await decode(store, `characters/${CHARACTER_ID}/clips/${RED_CLIP}/sheet.png`);
          const greenSheet = await decode(store, `characters/${CHARACTER_ID}/clips/${GREEN_CLIP}/sheet.png`);
          for (let y = 0; y < 6; y++) {
            for (let x = 0; x < 8; x++) {
              expect(pixel(sheet, x, y)).toEqual(pixel(redSheet, x, y));
              expect(pixel(sheet, 8 + x, y)).toEqual(pixel(greenSheet, x, y));
            }
          }
        });
      });
    });
  });

  it('is pure concatenation: a Clip listed twice plays twice (no offset, no repeat)', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);
          await commitSequence(store.root, {
            characterId: CHARACTER_ID,
            sequenceId: SEQUENCE_ID,
            clips: [RED_CLIP, RED_CLIP],
          });

          const sheet = await decode(store, `characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/sheet.png`);
          expect([sheet.width, sheet.height]).toEqual([16, 6]);
          expect(pixel(sheet, 1, 4)).toEqual([255, 0, 0, 255]);
          expect(pixel(sheet, 9, 4)).toEqual([255, 0, 0, 255]);

          // The recipe is just the ordered ids; there is no `at`/`repeat` field.
          const provenance = store.readJson(
            `characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/provenance.json`,
          ) as Record<string, unknown>;
          expect(provenance.clips).toEqual([RED_CLIP, RED_CLIP]);
          expect(provenance).not.toHaveProperty('at');
          expect(provenance).not.toHaveProperty('repeat');
        });
      });
    });
  });

  it('sums frameCount and concatenates per-frame delays (including a non-uniform input)', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);
          await commitSequence(store.root, {
            characterId: CHARACTER_ID,
            sequenceId: SEQUENCE_ID,
            clips: [RED_CLIP, GREEN_CLIP],
          });

          expect(
            store.readJson(`characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/meta.json`),
          ).toEqual({
            id: SEQUENCE_ID,
            frameCount: 4,
            delaysMs: [50, 60, 30, 70],
            loop: true,
          });
        });
      });
    });
  });

  it('expands a source Clip’s uniform delay to its frameCount before concatenating', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);
          // A uniform-1 Clip meta (Rule 5.1) must expand to one delay per frame.
          store.writeJson(`characters/${CHARACTER_ID}/clips/${RED_CLIP}/meta.json`, {
            id: RED_CLIP,
            frameCount: 2,
            delaysMs: [50],
            loop: true,
          });
          await commitSequence(store.root, {
            characterId: CHARACTER_ID,
            sequenceId: SEQUENCE_ID,
            clips: [RED_CLIP, GREEN_CLIP],
          });

          expect(
            (store.readJson(`characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/meta.json`) as {
              delaysMs: number[];
            }).delaysMs,
          ).toEqual([50, 50, 30, 70]);
        });
      });
    });
  });

  it('collapses an all-uniform sequence to one delay value', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 50], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 50], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);
          await commitSequence(store.root, {
            characterId: CHARACTER_ID,
            sequenceId: SEQUENCE_ID,
            clips: [RED_CLIP, GREEN_CLIP],
          });

          expect(
            store.readJson(`characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/meta.json`),
          ).toEqual({ id: SEQUENCE_ID, frameCount: 4, delaysMs: [50], loop: true });
        });
      });
    });
  });
});

describe('commitSequence — ids and immutability', () => {
  it('refuses an id already held by a Clip (one shared namespace)', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);
          await expect(
            commitSequence(store.root, {
              characterId: CHARACTER_ID,
              sequenceId: RED_CLIP,
              clips: [RED_CLIP, GREEN_CLIP],
            }),
          ).rejects.toThrow(StoreError);
          expect(store.listFiles().some((file) => file.includes(`/sequences/`))).toBe(false);
        });
      });
    });
  });

  it('never overwrites a committed Sequence (immutability)', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);
          await commitSequence(store.root, {
            characterId: CHARACTER_ID,
            sequenceId: SEQUENCE_ID,
            clips: [RED_CLIP, GREEN_CLIP],
          });
          const sheetRel = `characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/sheet.png`;
          const original = store.readText(sheetRel);

          await expect(
            commitSequence(store.root, {
              characterId: CHARACTER_ID,
              sequenceId: SEQUENCE_ID,
              clips: [GREEN_CLIP, RED_CLIP],
            }),
          ).rejects.toThrow(StoreError);
          expect(store.readText(sheetRel)).toBe(original);
        });
      });
    });
  });

  it('a Clip cannot take an id already held by a Sequence', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);
          await commitSequence(store.root, {
            characterId: CHARACTER_ID,
            sequenceId: SEQUENCE_ID,
            clips: [RED_CLIP, GREEN_CLIP],
          });

          // Re-extract the red Segment and try to commit it under the Sequence's id.
          await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RED_RECORDING,
            cutId: 'red',
          });
          await expect(
            commitDraft(store.root, {
              characterId: CHARACTER_ID,
              draftId: 'red',
              assetId: SEQUENCE_ID,
            }),
          ).rejects.toThrow(StoreError);
        });
      });
    });
  });

  it('is a hard error when a source Clip does not exist', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);
          await expect(
            commitSequence(store.root, {
              characterId: CHARACTER_ID,
              sequenceId: SEQUENCE_ID,
              clips: [RED_CLIP, 'missing'],
            }),
          ).rejects.toThrow(StoreError);
          expect(store.listFiles().some((file) => file.includes(`/sequences/`))).toBe(false);
        });
      });
    });
  });
});

describe('forking a Sequence', () => {
  it('yields the ordered Clip list and records derivedFrom on the next commit', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);
          await commitSequence(store.root, {
            characterId: CHARACTER_ID,
            sequenceId: SEQUENCE_ID,
            clips: [RED_CLIP, GREEN_CLIP],
          });
          const originalSheet = store.readText(
            `characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/sheet.png`,
          );

          const fork = await forkAsset(store.root, {
            characterId: CHARACTER_ID,
            kind: 'sequence',
            id: SEQUENCE_ID,
          });
          expect(fork).toEqual({
            kind: 'sequence',
            id: SEQUENCE_ID,
            clips: [RED_CLIP, GREEN_CLIP],
            derivedFrom: { kind: 'sequence', id: SEQUENCE_ID },
          });

          // Edit the list and re-concatenate; lineage is recorded and the parent kept.
          await commitSequence(store.root, {
            characterId: CHARACTER_ID,
            sequenceId: 'combo-2',
            clips: [GREEN_CLIP, RED_CLIP],
            derivedFrom: fork.derivedFrom,
          });
          expect(
            store.readJson(`characters/${CHARACTER_ID}/sequences/combo-2/provenance.json`),
          ).toMatchObject({
            clips: [GREEN_CLIP, RED_CLIP],
            derivedFrom: { kind: 'sequence', id: SEQUENCE_ID },
          });
          expect(store.readText(`characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/sheet.png`)).toBe(
            originalSheet,
          );
          await expect(validateStore(store.root)).resolves.toBeDefined();
        });
      });
    });
  });
});

describe('resizeCanvas re-bakes committed Sequences', () => {
  it('re-places a Sequence’s frames on the grown Canvas, content unchanged', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);
          await commitSequence(store.root, {
            characterId: CHARACTER_ID,
            sequenceId: SEQUENCE_ID,
            clips: [RED_CLIP, GREEN_CLIP],
          });
          const sheetRel = `characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/sheet.png`;
          const before = await decode(store, sheetRel);
          expect([before.width, before.height]).toEqual([16, 6]);

          const result = await resizeCanvas(store.root, {
            characterId: CHARACTER_ID,
            width: 8,
            height: 10,
          });

          // Every committed Sequence is re-baked, not left as a pending gap.
          expect(result.rebakedSequences).toEqual([SEQUENCE_ID]);

          // 4 frames x new canvas.width (8) wide, new canvas.height (10) tall.
          const after = await decode(store, sheetRel);
          expect([after.width, after.height]).toEqual([32, 10]);
          // Frame content re-placed by the Anchor delta ((8-4)/2, 10-6) = (2, 4).
          expect(pixel(after, 1 + 2, 4 + 4)).toEqual([255, 0, 0, 255]);
          expect(pixel(after, 16 + 1 + 2, 4 + 4)).toEqual([0, 255, 0, 255]);
          await expect(validateStore(store.root)).resolves.toBeDefined();
        });
      });
    });
  });
});

describe('forge CLI — Sequence round-trip', () => {
  it('commits a Sequence from --clips and reads it back with fork', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' }, async (red) => {
      await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' }, async (green) => {
        await withStore(async (store) => {
          await seedClips(red, green, store);
          const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
          const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
          try {
            const commitCode = await runCli([
              'commit',
              '--store',
              store.root,
              '--character',
              CHARACTER_ID,
              '--name',
              SEQUENCE_ID,
              '--kind',
              'sequence',
              '--clips',
              `${RED_CLIP},${GREEN_CLIP}`,
            ]);
            expect(commitCode).toBe(0);

            const forkCode = await runCli([
              'fork',
              '--store',
              store.root,
              '--character',
              CHARACTER_ID,
              '--kind',
              'sequence',
              '--id',
              SEQUENCE_ID,
            ]);
            expect(forkCode).toBe(0);

            expect(await runCli(['validate', '--store', store.root])).toBe(0);
          } finally {
            out.mockRestore();
            err.mockRestore();
          }

          expect(store.listFiles()).toContain(
            `characters/${CHARACTER_ID}/sequences/${SEQUENCE_ID}/sheet.png`,
          );
        });
      });
    });
  });
});
