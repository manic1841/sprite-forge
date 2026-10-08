import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validCanvas, validCuts, withStore } from './harness.js';

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
});
