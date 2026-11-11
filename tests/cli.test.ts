import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validCanvas, validCuts, withStore } from './harness.js';
import { withSyntheticGif } from './synthetic-gif.js';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the real CLI entry point in a child process — a true round-trip. */
async function forge(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', ...args],
      { cwd: projectRoot },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('forge CLI', () => {
  it('validate fails hard (non-zero exit) on a corrupt store', async () => {
    await withStore(async (store) => {
      store.writeJson('characters/hero/canvas.json', {
        width: 60,
        height: 84,
        anchor: { x: 31, y: 84 },
      });

      const result = await forge(['validate', '--store', store.root]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/validation failed/i);
    });
  });

  it('validate exits zero on a valid store', async () => {
    await withStore(async (store) => {
      store.writeJson('characters/hero/canvas.json', validCanvas());

      const result = await forge(['validate', '--store', store.root]);

      expect(result.code).toBe(0);
    });
  });

  it('scan prints the discovered tree as JSON', async () => {
    await withStore(async (store) => {
      store.writeJson('recordings/mgba-2026-09/cuts.json', validCuts());

      const result = await forge(['scan', '--store', store.root]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).recordings.map((r: { id: string }) => r.id)).toEqual([
        'mgba-2026-09',
      ]);
    });
  });

  it('ingest registers a Recording that scan then lists', async () => {
    await withSyntheticGif({ frames: 4, delaysMs: [50, 50, 60, 50] }, async (source) => {
      await withStore(async (store) => {
        const result = await forge([
          'ingest',
          '--store',
          store.root,
          '--recording-file',
          source.path,
          '--id',
          'mgba-2026-09',
        ]);

        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          id: 'mgba-2026-09',
          frameCount: 4,
          delaysMs: [50, 50, 60, 50],
        });

        const listed = await forge(['scan', '--store', store.root]);
        expect(JSON.parse(listed.stdout).recordings.map((r: { id: string }) => r.id)).toEqual([
          'mgba-2026-09',
        ]);
      });
    });
  });

  it('create-character writes a Character that scan then lists', async () => {
    await withStore(async (store) => {
      const result = await forge([
        'create-character',
        '--store',
        store.root,
        '--id',
        'hero',
        '--width',
        '60',
        '--height',
        '84',
        '--anchor-x',
        '30',
        '--anchor-y',
        '84',
      ]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        id: 'hero',
        canvas: { width: 60, height: 84, anchor: { x: 30, y: 84 } },
      });

      const listed = await forge(['scan', '--store', store.root]);
      expect(JSON.parse(listed.stdout).characters.map((c: { id: string }) => c.id)).toEqual([
        'hero',
      ]);
    });
  });

  it('create-character fails hard on a broken Anchor', async () => {
    await withStore(async (store) => {
      const result = await forge([
        'create-character',
        '--store',
        store.root,
        '--id',
        'hero',
        '--width',
        '61',
        '--height',
        '84',
        '--anchor-x',
        '30',
        '--anchor-y',
        '84',
      ]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/even integer/i);
    });
  });

  it("create-character derives the Canvas/Anchor from a Recording's first frame", async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (source) => {
      await withStore(async (store) => {
        const ingested = await forge([
          'ingest', '--store', store.root, '--recording-file', source.path, '--id', 'mgba-2026-09',
        ]);
        expect(ingested.code).toBe(0);

        const created = await forge([
          'create-character', '--store', store.root, '--id', 'hero', '--recording', 'mgba-2026-09',
        ]);

        expect(created.code, created.stderr).toBe(0);
        // First frame's content box { x:1, y:3, w:2, h:2 } -> bottom-centre (2,5).
        expect(JSON.parse(created.stdout).canvas).toEqual({
          width: 4,
          height: 5,
          anchor: { x: 2, y: 5 },
        });
        expect((await forge(['validate', '--store', store.root])).code).toBe(0);
      });
    });
  });

  it('cut adds a Segment that cut --action list then reads back', async () => {
    await withSyntheticGif({ frames: 4, delaysMs: [50, 50, 60, 50] }, async (source) => {
      await withStore(async (store) => {
        const ingested = await forge([
          'ingest',
          '--store',
          store.root,
          '--recording-file',
          source.path,
          '--id',
          'mgba-2026-09',
        ]);
        expect(ingested.code).toBe(0);

        const added = await forge([
          'cut',
          '--store',
          store.root,
          '--recording',
          'mgba-2026-09',
          '--action',
          'add',
          '--id',
          'walk',
          '--start',
          '1',
          '--end',
          '3',
        ]);
        expect(added.code).toBe(0);
        expect(JSON.parse(added.stdout)).toMatchObject({
          frameCount: 4,
          cuts: [{ id: 'walk', startFrame: 1, endFrame: 3 }],
        });

        const listed = await forge([
          'cut',
          '--store',
          store.root,
          '--recording',
          'mgba-2026-09',
          '--action',
          'list',
        ]);
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout).cuts).toEqual([
          { id: 'walk', startFrame: 1, endFrame: 3 },
        ]);

        const validated = await forge(['validate', '--store', store.root]);
        expect(validated.code).toBe(0);
      });
    });
  });

  it('cut sets and clears a Segment box, and rejects a malformed one', async () => {
    await withSyntheticGif({ frames: 4, delaysMs: [50, 50, 60, 50] }, async (source) => {
      await withStore(async (store) => {
        await forge([
          'ingest', '--store', store.root, '--recording-file', source.path, '--id', 'mgba-2026-09',
        ]);
        await forge([
          'cut', '--store', store.root, '--recording', 'mgba-2026-09',
          '--action', 'add', '--id', 'walk', '--start', '1', '--end', '3',
        ]);

        const boxed = await forge([
          'cut', '--store', store.root, '--recording', 'mgba-2026-09',
          '--action', 'rect', '--id', 'walk', '--rect', '1,2,3,4',
        ]);
        expect(boxed.code).toBe(0);
        expect(JSON.parse(boxed.stdout).cuts).toEqual([
          { id: 'walk', startFrame: 1, endFrame: 3, rect: { x: 1, y: 2, width: 3, height: 4 } },
        ]);

        const malformed = await forge([
          'cut', '--store', store.root, '--recording', 'mgba-2026-09',
          '--action', 'rect', '--id', 'walk', '--rect', '1,2,3',
        ]);
        expect(malformed.code).toBe(1);

        const cleared = await forge([
          'cut', '--store', store.root, '--recording', 'mgba-2026-09',
          '--action', 'rect', '--id', 'walk', '--rect', 'none',
        ]);
        expect(cleared.code).toBe(0);
        expect(JSON.parse(cleared.stdout).cuts).toEqual([
          { id: 'walk', startFrame: 1, endFrame: 3 },
        ]);
      });
    });
  });

  it('extract writes a Clip Draft that a reload reads back', async () => {    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (source) => {
      await withStore(async (store) => {
        expect(
          (
            await forge([
              'ingest',
              '--store',
              store.root,
              '--recording-file',
              source.path,
              '--id',
              'mgba-2026-09',
            ])
          ).code,
        ).toBe(0);
        expect(
          (
            await forge([
              'cut',
              '--store',
              store.root,
              '--recording',
              'mgba-2026-09',
              '--action',
              'add',
              '--id',
              'walk',
              '--start',
              '0',
              '--end',
              '2',
            ])
          ).code,
        ).toBe(0);
        expect(
          (
            await forge([
              'create-character',
              '--store',
              store.root,
              '--id',
              'hero',
              '--width',
              '4',
              '--height',
              '6',
              '--anchor-x',
              '2',
              '--anchor-y',
              '6',
            ])
          ).code,
        ).toBe(0);

        const extracted = await forge([
          'extract',
          '--store',
          store.root,
          '--character',
          'hero',
          '--recording',
          'mgba-2026-09',
          '--cut',
          'walk',
        ]);

        expect(extracted.code).toBe(0);
        expect(JSON.parse(extracted.stdout)).toMatchObject({
          id: 'walk',
          characterId: 'hero',
          frameCount: 2,
          delaysMs: [50, 60],
          background: { hex: '#9421ce', source: 'sampled', tolerance: 24 },
        });

        // The Draft is on disk and the store is still valid.
        expect(store.listFiles()).toContain('characters/hero/drafts/walk/draft.json');
        const validated = await forge(['validate', '--store', store.root]);
        expect(validated.code).toBe(0);
      });
    });
  });

  it('commit promotes a Draft and fork opens an Asset (round-trip)', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (source) => {
      await withStore(async (store) => {
        const seed = [
          ['ingest', '--store', store.root, '--recording-file', source.path, '--id', 'mgba-2026-09'],
          [
            'create-character', '--store', store.root, '--id', 'hero',
            '--width', '4', '--height', '6', '--anchor-x', '2', '--anchor-y', '6',
          ],
          [
            'cut', '--store', store.root, '--recording', 'mgba-2026-09',
            '--action', 'add', '--id', 'walk', '--start', '0', '--end', '2',
          ],
          ['extract', '--store', store.root, '--character', 'hero', '--recording', 'mgba-2026-09', '--cut', 'walk'],
        ];
        for (const args of seed) {
          expect((await forge(args)).code).toBe(0);
        }

        const committed = await forge([
          'commit', '--store', store.root, '--character', 'hero', '--draft', 'walk', '--name', 'walk-run',
        ]);
        expect(committed.code).toBe(0);
        expect(JSON.parse(committed.stdout)).toMatchObject({ kind: 'clip', id: 'walk-run' });

        const scanned = await forge(['scan', '--store', store.root]);
        expect(JSON.parse(scanned.stdout).characters[0].assets.map((a: { id: string }) => a.id)).toEqual([
          'walk-run',
        ]);

        const forked = await forge([
          'fork', '--store', store.root, '--character', 'hero', '--kind', 'clip', '--id', 'walk-run',
        ]);
        expect(forked.code).toBe(0);
        expect(JSON.parse(forked.stdout)).toMatchObject({
          derivedFrom: { kind: 'clip', id: 'walk-run' },
        });

        const recommitted = await forge([
          'commit', '--store', store.root, '--character', 'hero', '--draft', 'walk-run', '--name', 'walk-run-2',
        ]);
        expect(recommitted.code).toBe(0);

        const after = await forge(['scan', '--store', store.root]);
        expect(JSON.parse(after.stdout).characters[0].assets.map((a: { id: string }) => a.id)).toEqual([
          'walk-run',
          'walk-run-2',
        ]);
        const validated = await forge(['validate', '--store', store.root]);
        expect(validated.code).toBe(0);
      });
    });
  });

  it('repair appends, lists and undoes a Draft Repair operation (round-trip)', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (source) => {
      await withStore(async (store) => {
        const seed = [
          ['ingest', '--store', store.root, '--recording-file', source.path, '--id', 'mgba-2026-09'],
          [
            'create-character', '--store', store.root, '--id', 'hero',
            '--width', '4', '--height', '6', '--anchor-x', '2', '--anchor-y', '6',
          ],
          [
            'cut', '--store', store.root, '--recording', 'mgba-2026-09',
            '--action', 'add', '--id', 'walk', '--start', '0', '--end', '2',
          ],
          ['extract', '--store', store.root, '--character', 'hero', '--recording', 'mgba-2026-09', '--cut', 'walk'],
        ];
        for (const args of seed) {
          expect((await forge(args)).code).toBe(0);
        }

        const appended = await forge([
          'repair', '--store', store.root, '--character', 'hero', '--draft', 'walk',
          '--action', 'append', '--tool', 'erase-rect',
          '--start', '0', '--end', '1', '--x', '1', '--y', '4', '--width', '1', '--height', '1',
        ]);
        expect(appended.code).toBe(0);
        expect(JSON.parse(appended.stdout).operations).toEqual([
          { tool: 'erase-rect', frames: { start: 0, end: 1 }, geometry: { x: 1, y: 4, width: 1, height: 1 } },
        ]);

        const listed = await forge([
          'repair', '--store', store.root, '--character', 'hero', '--draft', 'walk', '--action', 'list',
        ]);
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout).operations).toHaveLength(1);

        const undone = await forge([
          'repair', '--store', store.root, '--character', 'hero', '--draft', 'walk', '--action', 'undo',
        ]);
        expect(undone.code).toBe(0);
        expect(JSON.parse(undone.stdout).operations).toEqual([]);

        expect((await forge(['validate', '--store', store.root])).code).toBe(0);
      });
    });
  });

  it('align sets a placement offset and resizes the Canvas (round-trip)', async () => {
    await withSyntheticGif({ frames: 2, width: 8, height: 6, delaysMs: [50, 60] }, async (source) => {
      await withStore(async (store) => {
        const seed = [
          ['ingest', '--store', store.root, '--recording-file', source.path, '--id', 'mgba-2026-09'],
          [
            'create-character', '--store', store.root, '--id', 'hero',
            '--width', '4', '--height', '6', '--anchor-x', '2', '--anchor-y', '6',
          ],
          [
            'cut', '--store', store.root, '--recording', 'mgba-2026-09',
            '--action', 'add', '--id', 'walk', '--start', '0', '--end', '2',
          ],
          ['extract', '--store', store.root, '--character', 'hero', '--recording', 'mgba-2026-09', '--cut', 'walk'],
        ];
        for (const args of seed) {
          expect((await forge(args)).code).toBe(0);
        }

        const offset = await forge([
          'align', '--store', store.root, '--character', 'hero',
          '--action', 'set-offset', '--draft', 'walk', '--x', '1', '--y=-1',
        ]);
        expect(offset.code, offset.stderr).toBe(0);
        expect(JSON.parse(offset.stdout)).toMatchObject({ placementOffset: { x: 1, y: -1 } });

        const expanded = await forge([
          'align', '--store', store.root, '--character', 'hero',
          '--action', 'resize', '--width', '6', '--height', '8',
        ]);
        expect(expanded.code).toBe(0);
        expect(JSON.parse(expanded.stdout).canvas).toEqual({
          width: 6,
          height: 8,
          anchor: { x: 3, y: 8 },
        });

        expect((await forge(['validate', '--store', store.root])).code).toBe(0);
      });
    });
  });
});
