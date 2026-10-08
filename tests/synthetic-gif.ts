// A tiny **synthetic animated GIF** fixture, built deterministically with `sharp`.
//
// Real mGBA recordings are hundreds of frames and megabytes; tests must not carry
// them. This helper builds a handful of flat frames with a known per-frame delay
// and a known moving shape, writes them to a temporary file **outside** any store
// (a Recording's source is external input), and hands back its path. Later tickets
// (#22 cut lists, #23 clip extraction) build on this to exercise frame content.
//
// The GIF container stores delays in centiseconds, and `sharp` reports them back
// in milliseconds, so `delaysMs` values must be multiples of 10 to survive the
// round-trip (see `docs/research/mgba-gif-ingestion.md`).
//
// Usage:
//
//   import { withSyntheticGif } from './synthetic-gif.js';
//
//   it('does something', async () => {
//     await withSyntheticGif({ frames: 4, delaysMs: [50, 50, 60, 50] }, async (src) => {
//       // src.path is an absolute path to a 4-frame GIF; src.delaysMs is [50,50,60,50]
//     }); // the temp file is removed even if the test throws
//   });

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

/** A synthetic animated GIF written to a temporary path. */
export interface SyntheticGif {
  /** Absolute path of the written `.gif` file. */
  readonly path: string;
  /** Logical frame width in pixels. */
  readonly width: number;
  /** Logical frame height in pixels (one page, not the stacked height). */
  readonly height: number;
  /** Number of frames. */
  readonly frameCount: number;
  /** Per-frame delays in ms, exactly as the GIF records them. */
  readonly delaysMs: readonly number[];
}

/** Options for {@link writeSyntheticGif}. All are optional with small defaults. */
export interface SyntheticGifOptions {
  /** Number of frames (default 4). */
  frames?: number;
  /** Frame width in px (default 8). */
  width?: number;
  /** Frame height in px (default 6). */
  height?: number;
  /** Per-frame delays in ms; length must equal `frames` (default `[50, 50, 60, 50]`). */
  delaysMs?: readonly number[];
  /** Flat background colour, `#rrggbb` (default `#9421ce`, the mGBA backdrop). */
  background?: string;
  /** Moving shape colour, `#rrggbb` (default `#ff0000`). */
  foreground?: string;
}

const DEFAULT_DELAYS_MS = [50, 50, 60, 50] as const;
const DEFAULT_BACKGROUND = '#9421ce';
const DEFAULT_FOREGROUND = '#ff0000';

/** Write a synthetic animated GIF named `recording.gif` into `dir`. */
export async function writeSyntheticGif(
  dir: string,
  options: SyntheticGifOptions = {},
): Promise<SyntheticGif> {
  const frames = options.frames ?? DEFAULT_DELAYS_MS.length;
  const width = options.width ?? 8;
  const height = options.height ?? 6;
  const delaysMs = options.delaysMs ?? DEFAULT_DELAYS_MS;
  if (delaysMs.length !== frames) {
    throw new Error(`delaysMs must have ${frames} entries; got ${delaysMs.length}`);
  }

  const background = parseHex(options.background ?? DEFAULT_BACKGROUND);
  const foreground = parseHex(options.foreground ?? DEFAULT_FOREGROUND);

  // Stack the frames vertically (sharp's "toilet roll") and tell sharp the page
  // height so it knows where one frame ends and the next begins.
  const stacked = Buffer.alloc(width * height * frames * 4);
  for (let frame = 0; frame < frames; frame++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // A 2x2 foreground square resting on the bottom edge, sliding right one
        // pixel per frame and wrapping — distinct frames, easy to assert on.
        const squareX = (frame + 1) % Math.max(1, width - 1);
        const inShape = y >= height - 3 && y < height - 1 && x >= squareX && x < squareX + 2;
        const at = ((frame * height + y) * width + x) * 4;
        const [r, g, b] = inShape ? foreground : background;
        stacked[at] = r;
        stacked[at + 1] = g;
        stacked[at + 2] = b;
        stacked[at + 3] = 0xff;
      }
    }
  }

  const file = path.join(dir, 'recording.gif');
  await sharp(stacked, {
    raw: { width, height: height * frames, channels: 4, pageHeight: height },
  })
    .gif({ loop: 0, delay: [...delaysMs], keepDuplicateFrames: true })
    .toFile(file);

  return { path: file, width, height, frameCount: frames, delaysMs: [...delaysMs] };
}

/** Run `body` with a synthetic animated GIF in a fresh temp dir; clean up after. */
export async function withSyntheticGif(
  options: SyntheticGifOptions,
  body: (gif: SyntheticGif) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sprite-forge-recording-'));
  try {
    await body(await writeSyntheticGif(dir, options));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Overwrite the bytes of an existing fixture (used to forge a swapped source). */
export function overwriteWithBytes(file: string, bytes: Uint8Array): void {
  writeFileSync(file, bytes);
}

function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) {
    throw new Error(`Expected a #rrggbb colour; got ${hex}`);
  }
  return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)];
}
