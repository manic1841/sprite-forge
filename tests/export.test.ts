// Ticket #30 — export to a Manifest.
//
// The seam is the core command surface, driven in-process against a temporary
// store. Tests assert on observable behaviour: the written export bundle (the
// manifest JSON and one sheet per exported Asset), its schema validity, the
// closed-export rules, and the CLI/web adapters — never on module internals.
//
// Fixture: a 4x6 Canvas, Anchor (2,6). One committed Clip seeded from a synthetic
// recording with a distinct foreground colour, so a copied sheet is observable.

import path from 'node:path';
import { unlinkSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  StoreError,
  ValidationError,
  addSegment,
  commitDraft,
  commitSequence,
  createCharacter,
  exportCharacter,
  extractClipDraft,
  ingestRecording,
  validateExport,
  validateStore,
} from '../src/core/index.js';
import { SPRITE_FORGE_VERSION } from '../src/core/version.js';
import { withStore, type StoreFixture } from './harness.js';
import { withSyntheticGif, type SyntheticGif } from './synthetic-gif.js';
import { runCli } from '../src/cli/index.js';

const CHARACTER_ID = 'hero';
const RECORDING_ID = 'rec-red';
const CLIP_ID = 'red-run';
const TARGET = 'pixel-pet';

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

/** Seed a Character's Canvas (idempotent) and commit one 2-frame Clip. */
async function seedClip(
  gif: SyntheticGif,
  store: StoreFixture,
  ids: { recordingId: string; cutId: string; clipId: string } = {
    recordingId: RECORDING_ID,
    cutId: 'red',
    clipId: CLIP_ID,
  },
): Promise<void> {
  if (!store.listFiles().includes(`characters/${CHARACTER_ID}/canvas.json`)) {
    await createCharacter(store.root, {
      characterId: CHARACTER_ID,
      width: 4,
      height: 6,
      anchor: { x: 2, y: 6 },
    });
  }
  await ingestRecording(store.root, { recordingId: ids.recordingId, sourcePath: gif.path });
  await addSegment(store.root, {
    recordingId: ids.recordingId,
    id: ids.cutId,
    startFrame: 0,
    endFrame: 2,
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

describe('exportCharacter', () => {
  it('writes a canvas-level manifest and one sheet per exported Asset', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);

          const result = await exportCharacter(store.root, {
            characterId: CHARACTER_ID,
            target: TARGET,
            animations: [CLIP_ID],
            bindings: { idle: [CLIP_ID] },
            situations: ['idle'],
          });

          expect(result.target).toBe(TARGET);
          expect(store.listFiles()).toEqual(
            expect.arrayContaining([
              `exports/${TARGET}/manifest.json`,
              `exports/${TARGET}/clips/${CLIP_ID}.png`,
            ]),
          );

          const manifest = store.readJson(`exports/${TARGET}/manifest.json`) as Record<string, unknown>;
          expect(manifest).toMatchObject({
            formatVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
            target: TARGET,
            character: CHARACTER_ID,
            authoredFacing: 'right',
            // Canvas-level: the shared Canvas appears once, at the top level.
            canvas: { width: 4, height: 6, anchor: { x: 2, y: 6 } },
            animations: {
              [CLIP_ID]: {
                sheet: `clips/${CLIP_ID}.png`,
                frameCount: 2,
                delaysMs: [50, 60],
                loop: true,
              },
            },
            bindings: { idle: [CLIP_ID] },
          });

          // The copied sheet is the committed Asset's sheet, byte for byte.
          const committed = await decode(store, `characters/${CHARACTER_ID}/clips/${CLIP_ID}/sheet.png`);
          const copied = await decode(store, `exports/${TARGET}/clips/${CLIP_ID}.png`);
          expect(copied.width).toBe(committed.width);
          expect(copied.height).toBe(committed.height);
          expect(copied.data.equals(committed.data)).toBe(true);

          await expect(validateStore(store.root)).resolves.toBeDefined();
        });
      },
    );
  });

  it('is canvas-level: one shared canvas and only the allowed per-animation fields', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);

          await exportCharacter(store.root, {
            characterId: CHARACTER_ID,
            target: TARGET,
            animations: [CLIP_ID],
            bindings: { idle: [CLIP_ID], happy: [CLIP_ID] },
            situations: ['idle', 'happy'],
          });

          const manifest = store.readJson(`exports/${TARGET}/manifest.json`) as {
            canvas: unknown;
            animations: Record<string, Record<string, unknown>>;
          };

          // The top level is exactly the contract's fields; canvas/anchor appear once.
          expect(Object.keys(manifest).sort()).toEqual(
            [
              'animations',
              'authoredFacing',
              'bindings',
              'canvas',
              'character',
              'formatVersion',
              'lock',
              'target',
            ].sort(),
          );
          expect(manifest.canvas).toEqual({ width: 4, height: 6, anchor: { x: 2, y: 6 } });

          // Each animation carries only sheet/frameCount/delaysMs/loop (+flipsFacing).
          expect(Object.keys(manifest.animations[CLIP_ID]!).sort()).toEqual([
            'delaysMs',
            'frameCount',
            'loop',
            'sheet',
          ]);
          // No frame size and no mirror flag leak into an animation.
          for (const animation of Object.values(manifest.animations)) {
            for (const forbidden of [
              'width',
              'height',
              'anchor',
              'frameWidth',
              'frameHeight',
              'mirror',
              'flip',
              'hitbox',
            ]) {
              expect(animation).not.toHaveProperty(forbidden);
            }
          }
        });
      },
    );
  });

  it('keeps consumer vocabulary out of the asset layer and store vocabulary out of bindings', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);
          const assetFiles = store
            .listFiles()
            .filter((file) => file.startsWith('characters/'));
          const before = assetFiles.map((file) => [file, store.readText(file)] as const);

          await exportCharacter(store.root, {
            characterId: CHARACTER_ID,
            target: TARGET,
            animations: [CLIP_ID],
            // `happy`/`alert` are Situations, not Asset ids — consumer vocabulary.
            bindings: { idle: [CLIP_ID], happy: [CLIP_ID, CLIP_ID], alert: [CLIP_ID] },
            situations: ['idle', 'happy', 'alert'],
          });

          // Export is read-only over the asset layer: not one store file changed.
          const after = assetFiles.map((file) => [file, store.readText(file)] as const);
          expect(after).toEqual(before);

          const manifest = store.readJson(`exports/${TARGET}/manifest.json`) as {
            animations: Record<string, unknown>;
            bindings: Record<string, string[]>;
          };

          // bindings values are animation ids (store vocabulary) — never paths/kinds.
          for (const ids of Object.values(manifest.bindings)) {
            for (const id of ids) {
              expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
              expect(manifest.animations).toHaveProperty(id);
            }
          }
          // bindings keys are Situation ids (id grammar), never store paths.
          for (const situation of Object.keys(manifest.bindings)) {
            expect(situation).toMatch(/^[a-z][a-z0-9-]*$/);
            expect(situation).not.toContain('/');
          }

          // A Situation id never enters the asset layer: `happy` appears only in
          // the manifest, nowhere under `characters/`.
          for (const file of assetFiles) {
            expect(store.readText(file)).not.toContain('happy');
          }
          const filesMentioningHappy = store
            .listFiles()
            .filter((file) => store.readText(file).includes('happy'));
          expect(filesMentioningHappy).toEqual([`exports/${TARGET}/manifest.json`]);

          await expect(validateStore(store.root)).resolves.toBeDefined();
        });
      },
    );
  });

  it('carries a semver formatVersion as the sole version field, plus a version/ISO lock', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);

          const exportedAt = '2026-10-08T00:00:00.000Z';
          await exportCharacter(store.root, {
            characterId: CHARACTER_ID,
            target: TARGET,
            animations: [CLIP_ID],
            bindings: { idle: [CLIP_ID] },
            situations: ['idle'],
            exportedAt,
          });

          const manifest = store.readJson(`exports/${TARGET}/manifest.json`) as {
            formatVersion: string;
            lock: { spriteForgeVersion: string; exportedAt: string };
          };
          expect(manifest.formatVersion).toMatch(/^\d+\.\d+\.\d+$/);
          expect(manifest.lock).toEqual({
            spriteForgeVersion: SPRITE_FORGE_VERSION,
            exportedAt,
          });
          expect(new Date(manifest.lock.exportedAt).toISOString()).toBe(exportedAt);

          // The store artifacts the export read stay free of a version field or
          // a `$schema` pointer (Rule 0.2) — `formatVersion` is Manifest-only.
          for (const relPath of [
            `characters/${CHARACTER_ID}/clips/${CLIP_ID}/meta.json`,
            `characters/${CHARACTER_ID}/clips/${CLIP_ID}/provenance.json`,
            `characters/${CHARACTER_ID}/canvas.json`,
          ]) {
            const artifact = store.readJson(relPath) as Record<string, unknown>;
            expect(artifact).not.toHaveProperty('$schema');
            expect(artifact).not.toHaveProperty('formatVersion');
            expect(artifact).not.toHaveProperty('schemaVersion');
          }
        });
      },
    );
  });

  it('carries flipsFacing through when set and omits it otherwise', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (red) => {
        await withSyntheticGif(
          { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#00ff00' },
          async (green) => {
            await withStore(async (store) => {
              await seedClip(red, store);
              await seedClip(green, store, {
                recordingId: 'rec-green',
                cutId: 'green',
                clipId: 'green-run',
              });

              const manifest = (
                await exportCharacter(store.root, {
                  characterId: CHARACTER_ID,
                  target: TARGET,
                  animations: [CLIP_ID, 'green-run'],
                  bindings: { idle: [CLIP_ID], turn: ['green-run'] },
                  situations: ['idle', 'turn'],
                  flipsFacing: ['green-run'],
                })
              ).manifest;

              expect(manifest.animations['green-run']!.flipsFacing).toBe(true);
              expect(manifest.animations[CLIP_ID]).not.toHaveProperty('flipsFacing');
              await expect(validateStore(store.root)).resolves.toBeDefined();
            });
          },
        );
      },
    );
  });
});

describe('closed export', () => {
  it('fails when a declared Situation is not bound', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);

          await expect(
            exportCharacter(store.root, {
              characterId: CHARACTER_ID,
              target: TARGET,
              animations: [CLIP_ID],
              bindings: { idle: [CLIP_ID] },
              situations: ['idle', 'happy'],
            }),
          ).rejects.toBeInstanceOf(StoreError);
        });
      },
    );
  });

  it('fails when a bound id is absent from animations', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);

          await expect(
            exportCharacter(store.root, {
              characterId: CHARACTER_ID,
              target: TARGET,
              animations: [CLIP_ID],
              bindings: { idle: ['not-exported'] },
              situations: ['idle'],
            }),
          ).rejects.toBeInstanceOf(StoreError);
        });
      },
    );
  });

  it('fails when an exported Asset has no sheet to copy', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);
          // Remove the committed Asset's sheet: there is nothing to export.
          unlinkSync(path.join(store.root, `characters/${CHARACTER_ID}/clips/${CLIP_ID}/sheet.png`));

          await expect(
            exportCharacter(store.root, {
              characterId: CHARACTER_ID,
              target: TARGET,
              animations: [CLIP_ID],
              bindings: { idle: [CLIP_ID] },
              situations: ['idle'],
            }),
          ).rejects.toBeInstanceOf(StoreError);
        });
      },
    );
  });

  it('validateExport fails when the written bundle is missing a sheet', async () => {
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
          });
          unlinkSync(path.join(store.root, `exports/${TARGET}/clips/${CLIP_ID}.png`));

          await expect(validateExport(store.root, TARGET)).rejects.toBeInstanceOf(ValidationError);
        });
      },
    );
  });

  it("validateExport fails when the manifest canvas differs from the Character's", async () => {
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
          });

          // A hand-edited manifest with the wrong Canvas must not validate.
          const manifest = store.readJson(`exports/${TARGET}/manifest.json`) as {
            canvas: unknown;
          };
          manifest.canvas = { width: 99, height: 99, anchor: { x: 49, y: 99 } };
          store.writeJson(`exports/${TARGET}/manifest.json`, manifest);

          await expect(validateExport(store.root, TARGET)).rejects.toBeInstanceOf(ValidationError);
        });
      },
    );
  });
});

describe('exporting a Sequence', () => {
  it('exports a committed Sequence’s concatenated sheet as one animation', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (red) => {
        await withSyntheticGif(
          { frames: 2, width: 8, height: 6, delaysMs: [30, 70], foreground: '#00ff00' },
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
                sequenceId: 'combo',
                clips: [CLIP_ID, 'green-run'],
              });

              const manifest = (
                await exportCharacter(store.root, {
                  characterId: CHARACTER_ID,
                  target: TARGET,
                  animations: ['combo'],
                  bindings: { idle: ['combo'] },
                  situations: ['idle'],
                })
              ).manifest;

              // A Sequence exports like any Asset: one sheet, its meta carried through.
              expect(manifest.animations['combo']).toMatchObject({
                sheet: 'clips/combo.png',
                frameCount: 4,
                loop: true,
              });
              const committed = await decode(
                store,
                `characters/${CHARACTER_ID}/sequences/combo/sheet.png`,
              );
              const copied = await decode(store, `exports/${TARGET}/clips/combo.png`);
              expect(copied.data.equals(committed.data)).toBe(true);
              await expect(validateStore(store.root)).resolves.toBeDefined();
            });
          },
        );
      },
    );
  });
});

describe('forge CLI — export', () => {
  it('exports from --bindings/--situations and a closed-export failure exits non-zero', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await seedClip(gif, store);

          const code = await runCli([
            'export',
            '--store',
            store.root,
            '--character',
            CHARACTER_ID,
            '--target',
            TARGET,
            '--animations',
            CLIP_ID,
            '--bindings',
            `idle=${CLIP_ID};happy=${CLIP_ID}`,
            '--situations',
            'idle,happy',
            '--flips-facing',
            CLIP_ID,
            '--authored-facing',
            'right',
          ]);
          expect(code).toBe(0);

          const manifest = store.readJson(`exports/${TARGET}/manifest.json`) as {
            bindings: Record<string, string[]>;
            animations: Record<string, { flipsFacing?: boolean }>;
            authoredFacing: string;
          };
          // CLI binding syntax `idle=<id>;happy=<id>` maps Situation -> animation id.
          expect(manifest.bindings).toEqual({ idle: [CLIP_ID], happy: [CLIP_ID] });
          expect(manifest.animations[CLIP_ID]!.flipsFacing).toBe(true);
          expect(manifest.authoredFacing).toBe('right');
          expect(store.listFiles()).toEqual(
            expect.arrayContaining([
              `exports/${TARGET}/manifest.json`,
              `exports/${TARGET}/clips/${CLIP_ID}.png`,
            ]),
          );

          // A declared-but-unbound Situation makes the CLI exit non-zero.
          const failed = await runCli([
            'export',
            '--store',
            store.root,
            '--character',
            CHARACTER_ID,
            '--target',
            'other-target',
            '--animations',
            CLIP_ID,
            '--bindings',
            `idle=${CLIP_ID}`,
            '--situations',
            'idle,happy',
          ]);
          expect(failed).toBe(1);
        });
      },
    );
  });
});
