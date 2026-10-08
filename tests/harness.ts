// Test harness shared by every ticket.
//
// Core verbs are driven **in-process against a temporary Asset store root**. A test
// builds a small fixture tree with this helper, calls a verb (e.g. `scan(root)`),
// and asserts on the resulting artifact tree. Never reach into module internals.
//
// Usage:
//
//   import { withStore } from './harness.js';
//
//   it('does something to the store', async () => {
//     await withStore(async (store) => {
//       store.writeJson('characters/hero/canvas.json', validCanvas());
//       await someVerb(store.root);
//       expect(store.readJson('characters/hero/clips/walk/meta.json')).toEqual(...);
//     }); // the temp root is removed even if the test throws
//   });
//
// `withStore` always cleans up in a `finally`. Paths passed to the fixture are
// **relative to the store root, POSIX separators** — the same convention the
// format contract uses. Parent directories are created on demand.

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A throwaway Asset store root, plus helpers to populate and inspect it. */
export interface StoreFixture {
  /** Absolute path of the temporary store root. Pass this to core verbs. */
  readonly root: string;
  /** Create a directory (and any parents) at a store-relative POSIX path. */
  mkdir(relPath: string): void;
  /** Write a file, creating parent directories. */
  writeFile(relPath: string, contents: string | Uint8Array): void;
  /** Write a JSON artifact, pretty-printed for readable diffs. */
  writeJson(relPath: string, value: unknown): void;
  /** Read a file back as UTF-8 text. */
  readText(relPath: string): string;
  /** Read a JSON artifact back. */
  readJson(relPath: string): unknown;
  /** Every file in the store, as sorted store-relative POSIX paths. */
  listFiles(): string[];
  /** Remove the temporary store root. Safe to call more than once. */
  cleanup(): void;
}

/** Create a temporary store root under the OS temp dir. Call `cleanup()` when done. */
export function createStoreFixture(): StoreFixture {
  const root = mkdtempSync(path.join(tmpdir(), 'sprite-forge-store-'));

  const abs = (relPath: string): string => path.join(root, relPath);

  const fixture: StoreFixture = {
    root,
    mkdir(relPath) {
      mkdirSync(abs(relPath), { recursive: true });
    },
    writeFile(relPath, contents) {
      mkdirSync(path.dirname(abs(relPath)), { recursive: true });
      writeFileSync(abs(relPath), contents);
    },
    writeJson(relPath, value) {
      fixture.writeFile(relPath, `${JSON.stringify(value, null, 2)}\n`);
    },
    readText(relPath) {
      return readFileSync(abs(relPath), 'utf8');
    },
    readJson(relPath) {
      return JSON.parse(fixture.readText(relPath));
    },
    listFiles() {
      return listFilesRecursive(root).sort();
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };

  return fixture;
}

/** Run `body` against a fresh temporary store, cleaning it up afterwards. */
export async function withStore(body: (store: StoreFixture) => void | Promise<void>): Promise<void> {
  const store = createStoreFixture();
  try {
    await body(store);
  } finally {
    store.cleanup();
  }
}

function listFilesRecursive(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

// --- Fixture artifact builders -------------------------------------------------
//
// Small, valid artifacts that satisfy the frozen schemas. Later tickets can add
// their own; these keep the common shapes in one place.

export function validCanvas(width = 60, height = 84): Record<string, unknown> {
  return { width, height, anchor: { x: width / 2, y: height } };
}

export function validCuts(): Record<string, unknown> {
  return {
    hash: `sha256:${'0'.repeat(64)}`,
    frameCount: 523,
    cuts: [{ id: 'walk', startFrame: 293, endFrame: 327 }],
  };
}

export function validAssetMeta(id: string, frameCount = 4): Record<string, unknown> {
  return { id, frameCount, delaysMs: [50], loop: true };
}

export function validClipProvenance(): Record<string, unknown> {
  return {
    recordingId: 'mgba-2026-09',
    recordingHash: `sha256:${'0'.repeat(64)}`,
    segment: { cutId: 'walk', startFrame: 293, endFrame: 327, speed: 1 },
    background: { hex: '#9421ce', source: 'sampled', tolerance: 24 },
    spriteForgeVersion: '0.1.0',
  };
}
