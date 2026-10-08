// The web front end is two thin adapters. This is the seam between them: the
// Node-side server turns HTTP/JSON into calls on the core command surface. The
// test drives that boundary in-process against a temporary store and asserts on
// the store (the same seam every other ticket uses), never on the server's
// internals.

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  addSegment,
  commitDraft,
  createCharacter,
  extractClipDraft,
  ingestRecording,
} from '../src/core/index.js';
import { handleApiRequest } from '../src/web/server.js';
import type { StoreFixture } from './harness.js';
import { withStore } from './harness.js';
import { withSyntheticGif } from './synthetic-gif.js';

const RECORDING_ID = 'mgba-2026-09';
const CUTS_PATH = `recordings/${RECORDING_ID}/cuts.json`;
const HASH = `sha256:${'a'.repeat(64)}`;

function seedRecording(store: StoreFixture, frameCount = 100): void {
  store.writeJson(CUTS_PATH, { hash: HASH, frameCount, cuts: [] });
}

const DRAFT_DIR = 'characters/hero/drafts/wip';
/** Bytes standing in for a frame PNG; the server serves them opaquely. */
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

/** Seed a valid 2-frame Draft (descriptor + frame files) and its Character. */
function seedDraft(store: StoreFixture): void {
  store.writeJson('characters/hero/canvas.json', {
    width: 4,
    height: 6,
    anchor: { x: 2, y: 6 },
  });
  store.writeJson(`${DRAFT_DIR}/draft.json`, {
    id: 'wip',
    characterId: 'hero',
    recordingId: RECORDING_ID,
    recordingHash: HASH,
    segment: { cutId: 'walk', startFrame: 0, endFrame: 2, speed: 1 },
    background: { hex: '#9421ce', source: 'sampled', tolerance: 24 },
    frameCount: 2,
    delaysMs: [50, 60],
    loop: true,
    spriteForgeVersion: '0.1.0',
  });
  for (let index = 0; index < 2; index += 1) {
    store.writeFile(`${DRAFT_DIR}/frames/${String(index).padStart(3, '0')}.png`, PNG_BYTES);
  }
}

describe('handleApiRequest', () => {
  it('lists the store from a scan of its directory tree', async () => {
    await withStore(async (store) => {
      seedRecording(store);
      store.writeJson('characters/hero/canvas.json', { width: 60, height: 84, anchor: { x: 30, y: 84 } });

      const response = await handleApiRequest(store.root, { method: 'GET', url: '/api/store' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        recordings: [{ id: RECORDING_ID }],
        characters: [{ id: 'hero', assets: [] }],
      });
    });
  });

  it('reads a Recording cut list', async () => {
    await withStore(async (store) => {
      seedRecording(store);

      const response = await handleApiRequest(store.root, {
        method: 'GET',
        url: `/api/recordings/${RECORDING_ID}/cuts`,
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ hash: HASH, frameCount: 100, cuts: [] });
    });
  });

  it('adds a Segment by delegating to the core verb (the store is written)', async () => {
    await withStore(async (store) => {
      seedRecording(store);

      const response = await handleApiRequest(store.root, {
        method: 'POST',
        url: `/api/recordings/${RECORDING_ID}/cuts`,
        body: { id: 'walk', startFrame: 10, endFrame: 20 },
      });

      expect(response.status).toBe(200);
      expect(store.readJson(CUTS_PATH)).toEqual({
        hash: HASH,
        frameCount: 100,
        cuts: [{ id: 'walk', startFrame: 10, endFrame: 20 }],
      });
    });
  });

  it('retargets a cut range by delegating to the core verb', async () => {
    await withStore(async (store) => {
      seedRecording(store);
      store.writeJson(CUTS_PATH, {
        hash: HASH,
        frameCount: 100,
        cuts: [{ id: 'walk', startFrame: 10, endFrame: 20 }],
      });

      const response = await handleApiRequest(store.root, {
        method: 'PATCH',
        url: `/api/recordings/${RECORDING_ID}/cuts/walk`,
        body: { startFrame: 12, endFrame: 30 },
      });

      expect(response.status).toBe(200);
      expect(store.readJson(CUTS_PATH)).toMatchObject({
        cuts: [{ id: 'walk', startFrame: 12, endFrame: 30 }],
      });
    });
  });

  it('removes a Segment by delegating to the core verb', async () => {
    await withStore(async (store) => {
      seedRecording(store);
      store.writeJson(CUTS_PATH, {
        hash: HASH,
        frameCount: 100,
        cuts: [{ id: 'walk', startFrame: 10, endFrame: 20 }],
      });

      const response = await handleApiRequest(store.root, {
        method: 'DELETE',
        url: `/api/recordings/${RECORDING_ID}/cuts/walk`,
      });

      expect(response.status).toBe(200);
      expect(store.readJson(CUTS_PATH)).toMatchObject({ cuts: [] });
    });
  });

  it('reports a core failure as a 400 and writes nothing', async () => {
    await withStore(async (store) => {
      seedRecording(store);

      const response = await handleApiRequest(store.root, {
        method: 'POST',
        url: `/api/recordings/${RECORDING_ID}/cuts`,
        body: { id: 'walk', startFrame: 20, endFrame: 20 },
      });

      expect(response.status).toBe(400);
      expect(store.readJson(CUTS_PATH)).toMatchObject({ cuts: [] });
    });
  });

  it('answers an unknown route with 404', async () => {
    await withStore(async (store) => {
      const response = await handleApiRequest(store.root, { method: 'GET', url: '/api/nope' });
      expect(response.status).toBe(404);
    });
  });
});

describe('the Draft / Clip-editor routes', () => {
  it('reads a Draft descriptor and its frame list', async () => {
    await withStore(async (store) => {
      seedDraft(store);

      const response = await handleApiRequest(store.root, {
        method: 'GET',
        url: '/api/characters/hero/drafts/wip',
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: 'wip',
        characterId: 'hero',
        frameCount: 2,
        delaysMs: [50, 60],
        frames: [
          'characters/hero/drafts/wip/frames/000.png',
          'characters/hero/drafts/wip/frames/001.png',
        ],
      });
    });
  });

  it('serves a Draft frame as PNG bytes behind the store boundary', async () => {
    await withStore(async (store) => {
      seedDraft(store);

      const response = await handleApiRequest(store.root, {
        method: 'GET',
        url: '/api/characters/hero/drafts/wip/frames/1',
      });

      expect(response.status).toBe(200);
      expect(response.contentType).toBe('image/png');
      expect(Buffer.isBuffer(response.body)).toBe(true);
      expect([...(response.body as Buffer)]).toEqual([...PNG_BYTES]);
    });
  });

  it('reports an out-of-range Draft frame as a core failure (400)', async () => {
    await withStore(async (store) => {
      seedDraft(store);

      const response = await handleApiRequest(store.root, {
        method: 'GET',
        url: '/api/characters/hero/drafts/wip/frames/9',
      });

      expect(response.status).toBe(400);
    });
  });

  it('reports a missing Draft as a core failure (400)', async () => {
    await withStore(async (store) => {
      const response = await handleApiRequest(store.root, {
        method: 'GET',
        url: '/api/characters/hero/drafts/nope',
      });
      expect(response.status).toBe(400);
    });
  });
});

/** A real 4x6 opaque-red-on-transparent PNG, so Repair can decode and replay it. */
async function realFramePng(): Promise<Buffer> {
  const data = Buffer.alloc(4 * 6 * 4);
  const at = (4 * 4 + 1) * 4;
  data[at] = 255;
  data[at + 3] = 255;
  return sharp(data, { raw: { width: 4, height: 6, channels: 4 } })
    .png()
    .toBuffer();
}

/** Seed a Draft whose frames are real PNGs (Repair decodes them). */
async function seedRealDraft(store: StoreFixture): Promise<void> {
  store.writeJson('characters/hero/canvas.json', {
    width: 4,
    height: 6,
    anchor: { x: 2, y: 6 },
  });
  store.writeJson(`${DRAFT_DIR}/draft.json`, {
    id: 'wip',
    characterId: 'hero',
    recordingId: RECORDING_ID,
    recordingHash: HASH,
    segment: { cutId: 'walk', startFrame: 0, endFrame: 2, speed: 1 },
    background: { hex: '#9421ce', source: 'sampled', tolerance: 24 },
    frameCount: 2,
    delaysMs: [50, 60],
    loop: true,
    spriteForgeVersion: '0.1.0',
  });
  const png = await realFramePng();
  store.writeFile(`${DRAFT_DIR}/frames/000.png`, png);
  store.writeFile(`${DRAFT_DIR}/frames/001.png`, png);
}

describe('the Repair routes', () => {
  it('reads a Draft’s Repair script (empty when there is none)', async () => {
    await withStore(async (store) => {
      await seedRealDraft(store);

      const response = await handleApiRequest(store.root, {
        method: 'GET',
        url: '/api/characters/hero/drafts/wip/repair',
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ operations: [], warnings: [] });
    });
  });

  it('appends an operation and serves the repaired frame bytes', async () => {
    await withStore(async (store) => {
      await seedRealDraft(store);

      const appended = await handleApiRequest(store.root, {
        method: 'POST',
        url: '/api/characters/hero/drafts/wip/repair/operations',
        body: {
          tool: 'erase-rect',
          frames: { start: 0, end: 1 },
          geometry: { x: 1, y: 4, width: 1, height: 1 },
        },
      });
      expect(appended.status).toBe(200);
      expect(store.listFiles()).toContain('characters/hero/repairs/wip/repair.json');

      const frame = await handleApiRequest(store.root, {
        method: 'GET',
        url: '/api/characters/hero/drafts/wip/frames/0',
      });
      const { data, info } = await sharp(frame.body as Buffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.width).toBe(4);
      expect(data[(4 * 4 + 1) * 4 + 3]).toBe(0);
    });
  });

  it('undoes the last operation', async () => {
    await withStore(async (store) => {
      await seedRealDraft(store);
      await handleApiRequest(store.root, {
        method: 'POST',
        url: '/api/characters/hero/drafts/wip/repair/operations',
        body: {
          tool: 'paint-brush',
          frames: { start: 0, end: 1 },
          geometry: { points: [[0, 0]], size: 1 },
          color: '#00ff00',
        },
      });

      const undone = await handleApiRequest(store.root, {
        method: 'POST',
        url: '/api/characters/hero/drafts/wip/repair/undo',
      });
      expect(undone.status).toBe(200);
      expect((undone.body as { operations: unknown[] }).operations).toEqual([]);
    });
  });

  it('samples a pixel colour for the eyedropper', async () => {
    await withStore(async (store) => {
      await seedRealDraft(store);

      const response = await handleApiRequest(store.root, {
        method: 'GET',
        url: '/api/characters/hero/drafts/wip/repair/sample?frame=0&x=1&y=4',
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ color: '#ff0000' });
    });
  });
});

describe('the Alignment routes', () => {
  it('reads a Character’s Canvas and its Clip/Draft offsets', async () => {
    await withStore(async (store) => {
      seedDraft(store);

      const response = await handleApiRequest(store.root, {
        method: 'GET',
        url: '/api/characters/hero/alignment',
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        canvas: { width: 4, height: 6, anchor: { x: 2, y: 6 } },
        clips: [],
        drafts: [{ id: 'wip' }],
      });
    });
  });

  it('sets a Draft’s placement offset by delegating to the core verb', async () => {
    await withStore(async (store) => {
      seedDraft(store);

      const response = await handleApiRequest(store.root, {
        method: 'POST',
        url: '/api/characters/hero/drafts/wip/alignment/offset',
        body: { x: 0, y: -2 },
      });

      expect(response.status).toBe(200);
      expect(store.readJson(`${DRAFT_DIR}/draft.json`)).toMatchObject({
        placementOffset: { x: 0, y: -2 },
      });
    });
  });

  it('expands the Canvas by delegating to the core verb', async () => {
    await withStore(async (store) => {
      await seedRealDraft(store);

      const response = await handleApiRequest(store.root, {
        method: 'POST',
        url: '/api/characters/hero/expand-canvas',
        body: { width: 8, height: 8 },
      });

      expect(response.status).toBe(200);
      expect(store.readJson('characters/hero/canvas.json')).toEqual({
        width: 8,
        height: 8,
        anchor: { x: 4, y: 8 },
      });
    });
  });

  it('serves a committed Asset’s sheet behind the store boundary', async () => {
    await withStore(async (store) => {
      seedDraft(store);
      store.writeFile('characters/hero/clips/walk/sheet.png', PNG_BYTES);

      const response = await handleApiRequest(store.root, {
        method: 'GET',
        url: '/api/characters/hero/clips/walk/sheet',
      });

      expect(response.status).toBe(200);
      expect(response.contentType).toBe('image/png');
      expect([...(response.body as Buffer)]).toEqual([...PNG_BYTES]);
    });
  });
});

describe('the Export routes', () => {
  it('exports by delegating to the core verb and reads the live manifest back', async () => {
    await withSyntheticGif(
      { frames: 2, width: 8, height: 6, delaysMs: [50, 60], foreground: '#ff0000' },
      async (gif) => {
        await withStore(async (store) => {
          await createCharacter(store.root, {
            characterId: 'hero',
            width: 4,
            height: 6,
            anchor: { x: 2, y: 6 },
          });
          await ingestRecording(store.root, { recordingId: 'rec', sourcePath: gif.path });
          await addSegment(store.root, { recordingId: 'rec', id: 'red', startFrame: 0, endFrame: 2 });
          await extractClipDraft(store.root, { characterId: 'hero', recordingId: 'rec', cutId: 'red' });
          await commitDraft(store.root, {
            characterId: 'hero',
            draftId: 'red',
            assetId: 'red-run',
          });

          const created = await handleApiRequest(store.root, {
            method: 'POST',
            url: '/api/characters/hero/exports/pixel-pet',
            body: {
              animations: ['red-run'],
              bindings: { idle: ['red-run'] },
              situations: ['idle'],
            },
          });
          expect(created.status).toBe(200);
          expect(store.listFiles()).toEqual(
            expect.arrayContaining([
              'exports/pixel-pet/manifest.json',
              'exports/pixel-pet/clips/red-run.png',
            ]),
          );

          const read = await handleApiRequest(store.root, {
            method: 'GET',
            url: '/api/exports/pixel-pet/manifest',
          });
          expect(read.status).toBe(200);
          expect(read.body).toMatchObject({
            target: 'pixel-pet',
            manifest: {
              target: 'pixel-pet',
              character: 'hero',
              animations: { 'red-run': { sheet: 'clips/red-run.png' } },
            },
          });
        });
      },
    );
  });
});
