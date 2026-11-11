// Ticket #31 — reproducibility and validity contract.
//
// The seam is the core command surface, driven in-process against a temporary
// store. Tests assert on observable behaviour: `verifyReproducible` re-runs a
// deterministic stage from stored provenance and compares artifacts byte for
// byte, and the validity warnings fire on the real user paths.
//
// Fixture: a 4x6 Canvas, Anchor (2,6). Committed Assets are seeded from a
// synthetic recording with a distinct foreground colour, so pixels are
// observable.

import path from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  addSegment,
  appendRepairOperation,
  applyRepairScript,
  checkRepairValidity,
  commitDraft,
  commitSequence,
  createCharacter,
  exportCharacter,
  resizeCanvas,
  extractClipDraft,
  ingestRecording,
  readDraftAlignment,
  readDraftRepair,
  setPlacementOffset,
  setSegmentRange,
  setSegmentRect,
  verifyReproducible,
} from '../src/core/index.js';
import { withStore, type StoreFixture } from './harness.js';
import { withSyntheticGif, type SyntheticGif } from './synthetic-gif.js';
import { runCli } from '../src/cli/index.js';

const CHARACTER_ID = 'hero';
const RECORDING_ID = 'rec-red';
const CLIP_ID = 'red-run';
const TARGET = 'pixel-pet';

/** Decode a PNG in the store into raw RGBA pixels. */
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

/** Seed a Character's Canvas (idempotent) and commit one Clip from a Segment. */
async function seedClip(
  gif: SyntheticGif,
  store: StoreFixture,
  ids: { recordingId: string; cutId: string; clipId: string; endFrame?: number } = {
    recordingId: RECORDING_ID,
    cutId: 'red',
    clipId: CLIP_ID,
  },
  canvas: { width: number; height: number } = { width: 4, height: 6 },
): Promise<void> {
  if (!store.listFiles().includes(`characters/${CHARACTER_ID}/canvas.json`)) {
    await createCharacter(store.root, {
      characterId: CHARACTER_ID,
      width: canvas.width,
      height: canvas.height,
      anchor: { x: canvas.width / 2, y: canvas.height },
    });
  }
  await ingestRecording(store.root, { recordingId: ids.recordingId, sourcePath: gif.path });
  await addSegment(store.root, {
    recordingId: ids.recordingId,
    id: ids.cutId,
    startFrame: 0,
    endFrame: ids.endFrame ?? 2,
  });
  await extractClipDraft(store.root, {
    characterId: CHARACTER_ID,
    recordingId: ids.recordingId,
    cutId: ids.cutId,
  });
  await commitDraft(store.root, {
    characterId: CHARACTER_ID,
    draftId: ids.cutId,
    assetId: ids.clipId,
  });
}

describe('verifyReproducible — a committed Clip', () => {
  it('re-runs the deterministic stage from provenance and agrees byte for byte', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);

          const report = await verifyReproducible(store.root, {
            characterId: CHARACTER_ID,
            kind: 'clip',
            id: CLIP_ID,
          });

          expect(report.reproducible).toBe(true);
          expect(report.mismatches).toEqual([]);
          expect(report.artifacts).toContain(
            `characters/${CHARACTER_ID}/clips/${CLIP_ID}/sheet.png`,
          );
        });
      },
    );
  });

  it('replays a boxed extract: the box is part of provenance', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);
          // A box records the window the pixels came through, so a re-run must
          // reach the same pixels through the same window.
          await setSegmentRect(store.root, {
            recordingId: RECORDING_ID,
            id: 'red',
            rect: { x: 1, y: 3, width: 2, height: 2 },
          });
          await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: 'red',
            draftId: 'red-boxed',
          });
          await commitDraft(store.root, {
            characterId: CHARACTER_ID,
            draftId: 'red-boxed',
            assetId: 'red-boxed',
          });

          const provenance = store.readJson(
            `characters/${CHARACTER_ID}/clips/red-boxed/provenance.json`,
          );
          expect(provenance).toMatchObject({ segment: { rect: { x: 1, y: 3, width: 2, height: 2 } } });

          const report = await verifyReproducible(store.root, {
            characterId: CHARACTER_ID,
            kind: 'clip',
            id: 'red-boxed',
          });
          expect(report.reproducible).toBe(true);
        });
      },
    );
  });

  it('detects a genuine mismatch: a tampered committed sheet does not reproduce', async () => {    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);

          // Corrupt one pixel of the committed sheet: the stored artifact now
          // diverges from what its provenance says it should be.
          const sheetRel = `characters/${CHARACTER_ID}/clips/${CLIP_ID}/sheet.png`;
          const decoded = await decode(store, sheetRel);
          decoded.data[0] = decoded.data[0]! ^ 0xff;
          const tampered = await sharp(decoded.data, {
            raw: { width: decoded.width, height: decoded.height, channels: 4 },
          })
            .png()
            .toBuffer();
          store.writeFile(sheetRel, tampered);

          const report = await verifyReproducible(store.root, {
            characterId: CHARACTER_ID,
            kind: 'clip',
            id: CLIP_ID,
          });

          expect(report.reproducible).toBe(false);
          expect(report.mismatches.map((mismatch) => mismatch.artifact)).toContain(sheetRel);
        });
      },
    );
  });

  it('derives frameCount and delaysMs from provenance, and treats loop as stored', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);
          const metaRel = `characters/${CHARACTER_ID}/clips/${CLIP_ID}/meta.json`;

          const report = await verifyReproducible(store.root, {
            characterId: CHARACTER_ID,
            kind: 'clip',
            id: CLIP_ID,
          });
          expect(report.artifacts).toContain(`${metaRel}#frameCount`);
          expect(report.artifacts).toContain(`${metaRel}#delaysMs`);
          // `loop` is a stored choice with no provenance to re-derive it from.
          expect(report.excluded).toContain(`${metaRel}#loop`);

          // A tampered delaysMs no longer agrees with the Recording + Segment.
          const meta = store.readJson(metaRel) as { delaysMs: number[] };
          meta.delaysMs = [50, 99];
          store.writeJson(metaRel, meta);

          const tampered = await verifyReproducible(store.root, {
            characterId: CHARACTER_ID,
            kind: 'clip',
            id: CLIP_ID,
          });
          expect(tampered.reproducible).toBe(false);
          expect(tampered.mismatches.map((mismatch) => mismatch.artifact)).toContain(
            `${metaRel}#delaysMs`,
          );
        });
      },
    );
  });

  it('is provenance-driven: re-cutting the Segment neither changes nor invalidates the committed sheet', async () => {
    await withSyntheticGif(
      { frames: 3, width: 8, height: 6, delaysMs: [50, 60, 70], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(
            gif,
            store,
            { recordingId: RECORDING_ID, cutId: 'red', clipId: CLIP_ID, endFrame: 2 },
            { width: 8, height: 6 },
          ); // the clip snapshots segment [0, 2)
          const sheetRel = `characters/${CHARACTER_ID}/clips/${CLIP_ID}/sheet.png`;
          const before = readFileSync(path.join(store.root, sheetRel));

          // Re-cut the Recording's Segment to three frames.
          await setSegmentRange(store.root, {
            recordingId: RECORDING_ID,
            id: 'red',
            startFrame: 0,
            endFrame: 3,
          });

          // A naive rebuild from the *current* cut list would now be three frames...
          const naive = await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: 'red',
            draftId: 'naive',
          });
          expect(naive.frameCount).toBe(3);

          // ...but the committed Clip is a baked snapshot: its sheet is unchanged...
          expect(readFileSync(path.join(store.root, sheetRel)).equals(before)).toBe(true);
          const meta = store.readJson(
            `characters/${CHARACTER_ID}/clips/${CLIP_ID}/meta.json`,
          ) as { frameCount: number };
          expect(meta.frameCount).toBe(2);

          // ...and re-running from its provenance still reproduces it exactly.
          const report = await verifyReproducible(store.root, {
            characterId: CHARACTER_ID,
            kind: 'clip',
            id: CLIP_ID,
          });
          expect(report.reproducible).toBe(true);
        });
      },
    );
  });

  it('stores Repair: the committed sheet keeps the human edit and stays reproducible', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await createCharacter(store.root, {
            characterId: CHARACTER_ID,
            width: 8,
            height: 6,
            anchor: { x: 4, y: 6 },
          });
          await ingestRecording(store.root, { recordingId: RECORDING_ID, sourcePath: gif.path });
          await addSegment(store.root, {
            recordingId: RECORDING_ID,
            id: 'red',
            startFrame: 0,
            endFrame: 2,
          });
          await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: 'red',
          });
          // A human edit that is NOT derivable from the raw frames: paint an opaque
          // pixel in the otherwise-transparent corner across both frames.
          await appendRepairOperation(store.root, {
            characterId: CHARACTER_ID,
            draftId: 'red',
            operation: {
              tool: 'paint-brush',
              frames: { start: 0, end: 2 },
              geometry: { points: [[1, 1]], size: 1 },
              color: '#ffffff',
            },
          });
          await commitDraft(store.root, {
            characterId: CHARACTER_ID,
            draftId: 'red',
            assetId: CLIP_ID,
          });

          const sheetRel = `characters/${CHARACTER_ID}/clips/${CLIP_ID}/sheet.png`;
          const committedBytes = readFileSync(path.join(store.root, sheetRel));
          const committed = await decode(store, sheetRel);
          // The repaired pixel is baked into the committed sheet.
          expect(pixelAt(committed, 1, 1)).toEqual([255, 255, 255, 255]);

          // A re-run replays the stored script and lands on the same bytes.
          const report = await verifyReproducible(store.root, {
            characterId: CHARACTER_ID,
            kind: 'clip',
            id: CLIP_ID,
          });
          expect(report.reproducible).toBe(true);

          // A plain re-extract (no Repair) differs — the human result is stored,
          // not recomputed from the raw frames.
          await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: 'red',
            draftId: 'raw',
          });
          await commitDraft(store.root, {
            characterId: CHARACTER_ID,
            draftId: 'raw',
            assetId: 'raw-run',
          });
          expect(readFileSync(path.join(store.root, sheetRel)).equals(committedBytes)).toBe(true);
          const raw = await decode(store, `characters/${CHARACTER_ID}/clips/raw-run/sheet.png`);
          expect(pixelAt(raw, 1, 1)).toEqual([0, 0, 0, 0]);
          expect(raw.data.equals(committed.data)).toBe(false);

          // Even with the Repair-script input removed, the baked sheet is unchanged:
          // it is the authoritative stored result, not a recomputation.
          unlinkSync(
            path.join(store.root, `characters/${CHARACTER_ID}/repairs/${CLIP_ID}/repair.json`),
          );
          expect(readFileSync(path.join(store.root, sheetRel)).equals(committedBytes)).toBe(true);
        });
      },
    );
  });
});

/** Read one RGBA pixel from a decoded image. */
function pixelAt(
  image: { width: number; data: Buffer },
  x: number,
  y: number,
): [number, number, number, number] {
  const at = (y * image.width + x) * 4;
  return [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!, image.data[at + 3]!];
}

describe('verifyReproducible — a committed Sequence', () => {
  it('re-concatenates the source Clips and agrees byte for byte', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (red) => {
        await withSyntheticGif(
          { frames: 2, width: 8, height: 6, delaysMs: [70, 80], foreground: '#00ff00' },
          async (green) => {
            await withStore(async (store) => {
              await seedClip(red, store);
              await seedClip(green, store, {
                recordingId: 'rec-green',
                cutId: 'green',
                clipId: 'green-run',
              });
              await commitSequence(store.root, {
                characterId: CHARACTER_ID,
                sequenceId: 'both',
                clips: [CLIP_ID, 'green-run'],
              });

              const report = await verifyReproducible(store.root, {
                characterId: CHARACTER_ID,
                kind: 'sequence',
                id: 'both',
              });
              expect(report.reproducible).toBe(true);
              expect(report.artifacts).toContain(
                `characters/${CHARACTER_ID}/sequences/both/sheet.png`,
              );

              // Corrupt the sequence sheet: the check must detect it.
              const sheetRel = `characters/${CHARACTER_ID}/sequences/both/sheet.png`;
              const decoded = await decode(store, sheetRel);
              decoded.data[3] = decoded.data[3]! ^ 0xff;
              store.writeFile(
                sheetRel,
                await sharp(decoded.data, {
                  raw: { width: decoded.width, height: decoded.height, channels: 4 },
                })
                  .png()
                  .toBuffer(),
              );

              const tampered = await verifyReproducible(store.root, {
                characterId: CHARACTER_ID,
                kind: 'sequence',
                id: 'both',
              });
              expect(tampered.reproducible).toBe(false);
            });
          },
        );
      },
    );
  });
});

describe('verifyReproducible — an Export', () => {
  it('re-runs the export and excludes the volatile lock.exportedAt', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);
          await exportCharacter(store.root, {
            characterId: CHARACTER_ID,
            target: TARGET,
            animations: [CLIP_ID],
            bindings: { idle: [CLIP_ID] },
            situations: ['idle'],
            exportedAt: '2026-10-09T00:00:00.000Z',
          });

          const manifestRel = `exports/${TARGET}/manifest.json`;
          const report = await verifyReproducible(store.root, {
            characterId: CHARACTER_ID,
            kind: 'export',
            id: TARGET,
          });
          expect(report.reproducible).toBe(true);
          expect(report.artifacts).toContain(manifestRel);
          expect(report.artifacts).toContain(`exports/${TARGET}/clips/${CLIP_ID}.png`);
          // The export timestamp is provenance, not pixels: excluded, and named.
          expect(report.excluded).toContain(`${manifestRel}#lock.exportedAt`);

          // Re-running the export with a *different* timestamp must not count as a
          // mismatch — the timestamp is excluded from the comparison.
          await exportCharacter(store.root, {
            characterId: CHARACTER_ID,
            target: TARGET,
            animations: [CLIP_ID],
            bindings: { idle: [CLIP_ID] },
            situations: ['idle'],
            exportedAt: '2030-01-01T12:00:00.000Z',
          });
          const after = await verifyReproducible(store.root, {
            characterId: CHARACTER_ID,
            kind: 'export',
            id: TARGET,
          });
          expect(after.reproducible).toBe(true);

          // A tampered copied sheet is detected.
          const sheetRel = `exports/${TARGET}/clips/${CLIP_ID}.png`;
          const decoded = await decode(store, sheetRel);
          decoded.data[0] = decoded.data[0]! ^ 0xff;
          store.writeFile(
            sheetRel,
            await sharp(decoded.data, {
              raw: { width: decoded.width, height: decoded.height, channels: 4 },
            })
              .png()
              .toBuffer(),
          );
          const tampered = await verifyReproducible(store.root, {
            characterId: CHARACTER_ID,
            kind: 'export',
            id: TARGET,
          });
          expect(tampered.reproducible).toBe(false);
        });
      },
    );
  });
});

describe('validity warnings', () => {
  it('warns that a stored Repair script may be stale after a re-cut and re-extract', async () => {
    await withSyntheticGif(
      { frames: 3, width: 8, height: 6, delaysMs: [50, 60, 70], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await createCharacter(store.root, {
            characterId: CHARACTER_ID,
            width: 8,
            height: 6,
            anchor: { x: 4, y: 6 },
          });
          await ingestRecording(store.root, { recordingId: RECORDING_ID, sourcePath: gif.path });
          await addSegment(store.root, {
            recordingId: RECORDING_ID,
            id: 'red',
            startFrame: 0,
            endFrame: 2,
          });
          await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: 'red',
          });
          await appendRepairOperation(store.root, {
            characterId: CHARACTER_ID,
            draftId: 'red',
            operation: {
              tool: 'paint-brush',
              frames: { start: 0, end: 2 },
              geometry: { points: [[1, 1]], size: 1 },
              color: '#ffffff',
            },
          });

          // No warning yet: the script still matches the frames it was drawn on.
          expect(
            (await readDraftRepair(store.root, { characterId: CHARACTER_ID, draftId: 'red' }))
              .warnings,
          ).toEqual([]);

          // Re-cut the Segment, then re-extract the Draft: its frames change.
          await setSegmentRange(store.root, {
            recordingId: RECORDING_ID,
            id: 'red',
            startFrame: 0,
            endFrame: 3,
          });
          await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: 'red',
          });

          const state = await readDraftRepair(store.root, {
            characterId: CHARACTER_ID,
            draftId: 'red',
          });
          expect(state.warnings.map((warning) => warning.code)).toContain('framing-changed');
        });
      },
    );
  });

  it('warns that a Repair script and a placement offset are stale after resizeCanvas', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await createCharacter(store.root, {
            characterId: CHARACTER_ID,
            width: 8,
            height: 6,
            anchor: { x: 4, y: 6 },
          });
          await ingestRecording(store.root, { recordingId: RECORDING_ID, sourcePath: gif.path });
          await addSegment(store.root, {
            recordingId: RECORDING_ID,
            id: 'red',
            startFrame: 0,
            endFrame: 2,
          });
          await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: 'red',
          });
          await appendRepairOperation(store.root, {
            characterId: CHARACTER_ID,
            draftId: 'red',
            operation: {
              tool: 'erase-rect',
              frames: { start: 0, end: 2 },
              geometry: { x: 1, y: 1, width: 2, height: 1 },
            },
          });
          await setPlacementOffset(store.root, {
            characterId: CHARACTER_ID,
            draftId: 'red',
            offset: { x: 1, y: 0 },
          });

          await resizeCanvas(store.root, { characterId: CHARACTER_ID, width: 10, height: 8 });

          const repair = await readDraftRepair(store.root, {
            characterId: CHARACTER_ID,
            draftId: 'red',
          });
          expect(repair.warnings.map((warning) => warning.code)).toContain('framing-changed');

          const alignment = await readDraftAlignment(store.root, {
            characterId: CHARACTER_ID,
            draftId: 'red',
          });
          expect(alignment.warnings.map((warning) => warning.code)).toContain(
            'alignment-framing-changed',
          );
        });
      },
    );
  });

  it('reports Repair-validity warnings for a committed Clip when the Canvas expands', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await createCharacter(store.root, {
            characterId: CHARACTER_ID,
            width: 8,
            height: 6,
            anchor: { x: 4, y: 6 },
          });
          await ingestRecording(store.root, { recordingId: RECORDING_ID, sourcePath: gif.path });
          await addSegment(store.root, {
            recordingId: RECORDING_ID,
            id: 'red',
            startFrame: 0,
            endFrame: 2,
          });
          await extractClipDraft(store.root, {
            characterId: CHARACTER_ID,
            recordingId: RECORDING_ID,
            cutId: 'red',
          });
          await appendRepairOperation(store.root, {
            characterId: CHARACTER_ID,
            draftId: 'red',
            operation: {
              tool: 'paint-brush',
              frames: { start: 0, end: 2 },
              geometry: { points: [[1, 1]], size: 1 },
              color: '#ffffff',
            },
          });
          await commitDraft(store.root, {
            characterId: CHARACTER_ID,
            draftId: 'red',
            assetId: CLIP_ID,
          });

          const result = await resizeCanvas(store.root, {
            characterId: CHARACTER_ID,
            width: 10,
            height: 8,
          });
          expect(result.repairWarnings.map((warning) => warning.code)).toContain('framing-changed');
        });
      },
    );
  });

  it('never silently misapplies a stale script: replay skips out-of-range frames and clamps geometry', () => {
    const frame = { width: 2, height: 2, data: new Uint8Array(2 * 2 * 4) };
    const script = {
      operations: [
        // Targets a frame that no longer exists.
        {
          tool: 'erase-brush' as const,
          frames: { start: 9, end: 10 },
          geometry: { points: [[0, 0]] as Array<[number, number]>, size: 1 },
        },
        // Draws entirely outside the frame; must be clamped, not written out of bounds.
        {
          tool: 'paint-brush' as const,
          frames: { start: 0, end: 1 },
          geometry: { points: [[100, 100]] as Array<[number, number]>, size: 4 },
          color: '#ffffff',
        },
      ],
    };

    const out = applyRepairScript([frame], script);
    // Nothing was written: the out-of-range op was skipped and the paint clamped away.
    expect(Array.from(out[0]!.data)).toEqual(Array.from(frame.data));

    const warnings = checkRepairValidity(script, { frameCount: 1, width: 2, height: 2 });
    expect(warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['frames-out-of-range', 'geometry-out-of-bounds']),
    );
  });
});

describe('forge verify-reproducible CLI', () => {
  it('exits 0 when reproducible and 1 when the artifact has drifted', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);
          const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
          const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
          try {
            const code = await runCli([
              'verify-reproducible',
              '--store',
              store.root,
              '--character',
              CHARACTER_ID,
              '--kind',
              'clip',
              '--id',
              CLIP_ID,
            ]);
            expect(code).toBe(0);

            // Drift the committed sheet: the same invocation now reports failure.
            const sheetRel = `characters/${CHARACTER_ID}/clips/${CLIP_ID}/sheet.png`;
            const decoded = await decode(store, sheetRel);
            decoded.data[0] = decoded.data[0]! ^ 0xff;
            store.writeFile(
              sheetRel,
              await sharp(decoded.data, {
                raw: { width: decoded.width, height: decoded.height, channels: 4 },
              })
                .png()
                .toBuffer(),
            );

            const drifted = await runCli([
              'verify-reproducible',
              '--store',
              store.root,
              '--character',
              CHARACTER_ID,
              '--kind',
              'clip',
              '--id',
              CLIP_ID,
            ]);
            expect(drifted).toBe(1);
          } finally {
            out.mockRestore();
            err.mockRestore();
          }
        });
      },
    );
  });
});