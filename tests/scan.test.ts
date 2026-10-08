import { describe, expect, it } from 'vitest';
import { scan } from '../src/core/index.js';
import { validAssetMeta, validCanvas, validClipProvenance, validCuts, withStore } from './harness.js';

describe('scan', () => {
  it('lists recordings, characters, committed assets and exports by scanning the tree', async () => {
    await withStore(async (store) => {
      store.writeFile('recordings/mgba-2026-09/source.gif', 'GIF89a');
      store.writeJson('recordings/mgba-2026-09/cuts.json', validCuts());

      store.writeJson('characters/hero/canvas.json', validCanvas());
      store.writeJson('characters/hero/clips/walk/meta.json', validAssetMeta('walk'));
      store.writeJson('characters/hero/clips/walk/provenance.json', validClipProvenance());
      store.writeJson('characters/hero/sequences/walk-run/meta.json', validAssetMeta('walk-run'));

      // Uncommitted work must NOT be reported as a committed Asset.
      store.writeJson('characters/hero/drafts/wip/meta.json', validAssetMeta('wip'));

      store.writeJson('exports/pixel-pet/manifest.json', {});

      const before = store.listFiles();
      const tree = await scan(store.root);

      // Scanning discovers from the tree alone and never writes a catalog/index.
      expect(store.listFiles()).toEqual(before);

      expect(tree.recordings.map((r) => r.id)).toEqual(['mgba-2026-09']);
      expect(tree.recordings[0]?.dir).toBe('recordings/mgba-2026-09');

      expect(tree.characters.map((c) => c.id)).toEqual(['hero']);
      expect(tree.characters[0]?.assets).toEqual([
        { kind: 'clip', id: 'walk', dir: 'characters/hero/clips/walk' },
        { kind: 'sequence', id: 'walk-run', dir: 'characters/hero/sequences/walk-run' },
      ]);

      expect(tree.exports.map((e) => e.target)).toEqual(['pixel-pet']);
      expect(tree.exports[0]?.dir).toBe('exports/pixel-pet');
    });
  });

  it('reports an empty store as empty rather than failing', async () => {
    await withStore(async (store) => {
      const tree = await scan(store.root);
      expect(tree.recordings).toEqual([]);
      expect(tree.characters).toEqual([]);
      expect(tree.exports).toEqual([]);
    });
  });

  it('fails hard when the store root does not exist', async () => {
    await withStore(async (store) => {
      await expect(scan(`${store.root}/does-not-exist`)).rejects.toThrow(/store root/i);
    });
  });
});
