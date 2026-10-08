/**
 * `background` — de-background frames by colour-keying.
 *
 * The mGBA decode is **already composited and fully opaque**: transparency cannot
 * be recovered from the GIF's transparent index (docs/research/mgba-gif-ingestion.md
 * §2). Transparency is therefore produced here, by **colour-keying** the flat
 * backdrop to binary alpha. The backdrop colour is **sampled from a corner** of
 * the frames — never read from the GIF background index, which is untrusted
 * (research §3).
 *
 * Everything in this module is **pure**: it works over in-memory RGBA buffers and
 * never touches the filesystem.
 */

import { StoreError } from './errors.js';

/** Default per-channel tolerance for the colour key (research §3). */
export const DEFAULT_TOLERANCE = 24;

/** Alpha for a pixel that matches the keyed background: fully transparent. */
export const KEYED_ALPHA = 0;

/** Alpha for a pixel that does not match the background: fully opaque. */
export const SUBJECT_ALPHA = 255;

/** A colour with 8-bit channels. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** A raw RGBA image: `data` is `width * height * 4` bytes, row-major from top-left. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Parse a `#rrggbb` colour, normalising to lowercase. Throws `StoreError` for
 * anything else: colours in the store are always lowercase `#rrggbb`
 * (format-spec §0).
 */
export function parseHexColor(hex: string): Rgb {
  if (!HEX_COLOR.test(hex)) {
    throw new StoreError(`Expected a #rrggbb colour; got "${hex}".`);
  }
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/** Format a colour as lowercase `#rrggbb`. */
export function toHexColor(color: Rgb): string {
  const part = (value: number): string => value.toString(16).padStart(2, '0');
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

/**
 * Sample the flat backdrop colour from the **four corners of every frame** and
 * return the most frequent one. The corners are far from the subject, and taking
 * the mode across frames is robust to a stray non-background corner; ties break
 * towards the first corner seen (top-left of the first frame), keeping the result
 * deterministic.
 */
export function sampleBackgroundColor(frames: readonly RgbaImage[]): Rgb {
  if (frames.length === 0) {
    throw new StoreError('Cannot sample a background colour from zero frames.');
  }

  const counts = new Map<string, { color: Rgb; count: number }>();
  for (const frame of frames) {
    for (const { x, y } of cornerPoints(frame)) {
      const color = pixelAt(frame, x, y);
      const key = `${color.r},${color.g},${color.b}`;
      const entry = counts.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        counts.set(key, { color, count: 1 });
      }
    }
  }

  let best: { color: Rgb; count: number } | undefined;
  for (const entry of counts.values()) {
    if (best === undefined || entry.count > best.count) {
      best = entry;
    }
  }
  return best!.color;
}

/** Key `background` to **binary** alpha within a per-channel `tolerance`. */
export function keyBackground(
  image: RgbaImage,
  background: Rgb,
  tolerance: number,
): RgbaImage {
  const data = new Uint8Array(image.data.length);
  for (let at = 0; at < image.data.length; at += 4) {
    const keyed =
      Math.abs(image.data[at]! - background.r) <= tolerance &&
      Math.abs(image.data[at + 1]! - background.g) <= tolerance &&
      Math.abs(image.data[at + 2]! - background.b) <= tolerance;
    data[at] = image.data[at]!;
    data[at + 1] = image.data[at + 1]!;
    data[at + 2] = image.data[at + 2]!;
    data[at + 3] = keyed ? KEYED_ALPHA : SUBJECT_ALPHA;
  }
  return { width: image.width, height: image.height, data };
}

/** The four corner pixel coordinates of an image: TL, TR, BL, BR. */
function cornerPoints(image: RgbaImage): Array<{ x: number; y: number }> {
  return [
    { x: 0, y: 0 },
    { x: image.width - 1, y: 0 },
    { x: 0, y: image.height - 1 },
    { x: image.width - 1, y: image.height - 1 },
  ];
}

function pixelAt(image: RgbaImage, x: number, y: number): Rgb {
  const at = (y * image.width + x) * 4;
  return { r: image.data[at]!, g: image.data[at + 1]!, b: image.data[at + 2]! };
}
