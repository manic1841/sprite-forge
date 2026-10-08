// The web front end is two thin adapters. This is the seam between them: the
// Node-side server turns HTTP/JSON into calls on the core command surface. The
// test drives that boundary in-process against a temporary store and asserts on
// the store (the same seam every other ticket uses), never on the server's
// internals.

import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../src/web/server.js';
import type { StoreFixture } from './harness.js';
import { withStore } from './harness.js';

const RECORDING_ID = 'mgba-2026-09';
const CUTS_PATH = `recordings/${RECORDING_ID}/cuts.json`;
const HASH = `sha256:${'a'.repeat(64)}`;

function seedRecording(store: StoreFixture, frameCount = 100): void {
  store.writeJson(CUTS_PATH, { hash: HASH, frameCount, cuts: [] });
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
