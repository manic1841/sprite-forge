import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { scan } from '../src/core/index.js';
import { ingestRecording } from '../src/core/index.js';
import { validateStore, StoreError } from '../src/core/index.js';
import { withStore } from './harness.js';
import { withSyntheticGif, writeSyntheticGif } from './synthetic-gif.js';

describe('ingestRecording', () => {
  it('places the source in the store and records the caller-assigned recording id', async () => {
    await withSyntheticGif({ frames: 4, delaysMs: [50, 50, 60, 50] }, async (source) => {
      await withStore(async (store) => {
        const result = await ingestRecording(store.root, {
          recordingId: 'mgba-2026-09',
          sourcePath: source.path,
        });

        expect(result.id).toBe('mgba-2026-09');
        expect(result.dir).toBe('recordings/mgba-2026-09');
        expect(store.listFiles()).toEqual([
          'recordings/mgba-2026-09/cuts.json',
          'recordings/mgba-2026-09/source.gif',
        ]);

        const cuts = store.readJson('recordings/mgba-2026-09/cuts.json');
        expect(cuts).toMatchObject({ frameCount: 4, cuts: [] });

        const tree = await scan(store.root);
        expect(tree.recordings.map((recording) => recording.id)).toEqual(['mgba-2026-09']);
      });
    });
  });

  it('captures the content hash and the full per-frame delays array', async () => {
    await withSyntheticGif({ frames: 4, delaysMs: [50, 50, 60, 50] }, async (source) => {
      await withStore(async (store) => {
        const result = await ingestRecording(store.root, {
          recordingId: 'mgba-2026-09',
          sourcePath: source.path,
        });

        const expectedHash = `sha256:${createHash('sha256')
          .update(readFileSync(source.path))
          .digest('hex')}`;
        expect(result.frameCount).toBe(4);
        expect(result.hash).toBe(expectedHash);
        // The non-uniform pattern survives: it is an array, not one collapsed value.
        expect(result.delaysMs).toEqual([50, 50, 60, 50]);
        expect(new Set(result.delaysMs).size).toBeGreaterThan(1);

        const cuts = store.readJson('recordings/mgba-2026-09/cuts.json');
        expect(cuts).toMatchObject({ hash: expectedHash, frameCount: 4, cuts: [] });
        // The written cut list satisfies the frozen schema.
        await expect(validateStore(store.root)).resolves.toMatchObject({
          artifacts: [{ kind: 'cuts', path: 'recordings/mgba-2026-09/cuts.json' }],
        });
      });
    });
  });

  it('detects a source whose hash or frame count no longer matches what was recorded', async () => {
    await withSyntheticGif({ frames: 4, delaysMs: [50, 50, 60, 50] }, async (source) => {
      await withStore(async (store) => {
        const options = { recordingId: 'mgba-2026-09', sourcePath: source.path };
        const first = await ingestRecording(store.root, options);

        // Same frame count, different pixels -> a different content hash.
        await writeSyntheticGif(path.dirname(source.path), { frames: 4, foreground: '#00ff00' });
        await expect(ingestRecording(store.root, options)).rejects.toThrow(StoreError);
        expect(store.readJson('recordings/mgba-2026-09/cuts.json')).toMatchObject({
          hash: first.hash,
          frameCount: 4,
        });

        // A different frame count is caught too.
        await writeSyntheticGif(path.dirname(source.path), {
          frames: 5,
          delaysMs: [50, 50, 50, 50, 50],
        });
        await expect(ingestRecording(store.root, options)).rejects.toThrow(StoreError);
        expect(store.readJson('recordings/mgba-2026-09/cuts.json')).toMatchObject({
          hash: first.hash,
          frameCount: 4,
        });
      });
    });
  });

  it('rejects a recording id that does not match the id grammar', async () => {
    await withSyntheticGif({}, async (source) => {
      await withStore(async (store) => {
        await expect(
          ingestRecording(store.root, { recordingId: 'Bad_Id', sourcePath: source.path }),
        ).rejects.toThrow(StoreError);
        expect(store.listFiles()).toEqual([]);
      });
    });
  });
});
