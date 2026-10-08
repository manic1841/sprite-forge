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
          '--source',
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
});
