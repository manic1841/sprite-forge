/**
 * `frames` — crop to content bounds and place on the shared Canvas.
 *
 * After de-backgrounding, a Clip's frames are **cropped to the union of their
 * content bounds** so no frame carries dead margin, then **placed on the
 * Character's shared Canvas** so every Asset of the Character lines up
 * (docs/alignment.md). All functions here are pure buffer operations.
 */

import type { RgbaImage } from './background.js';

/** An axis-aligned pixel rectangle. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The tight bounding box of the image's non-transparent pixels, or `null` when
 * every pixel is transparent.
 */
export function contentBounds(image: RgbaImage): Bounds | null {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** The smallest box containing every box in `boxes`. */
export function unionBounds(boxes: readonly Bounds[]): Bounds {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Copy the `bounds` region of `image` into a new, tight image. */
export function cropTo(image: RgbaImage, bounds: Bounds): RgbaImage {
  const data = new Uint8Array(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const from = ((bounds.y + y) * image.width + (bounds.x + x)) * 4;
      const to = (y * bounds.width + x) * 4;
      data.set(image.data.subarray(from, from + 4), to);
    }
  }
  return { width: bounds.width, height: bounds.height, data };
}

/**
 * Blit `image` onto a transparent Canvas-sized image at `(x, y)`. Pixels that
 * would fall outside the Canvas are skipped (the caller checks the content fits
 * before placing).
 */
export function placeOnCanvas(
  image: RgbaImage,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
): RgbaImage {
  const data = new Uint8Array(canvasWidth * canvasHeight * 4);
  for (let sy = 0; sy < image.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= canvasHeight) {
      continue;
    }
    for (let sx = 0; sx < image.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= canvasWidth) {
        continue;
      }
      const from = (sy * image.width + sx) * 4;
      const to = (dy * canvasWidth + dx) * 4;
      data.set(image.data.subarray(from, from + 4), to);
    }
  }
  return { width: canvasWidth, height: canvasHeight, data };
}

/**
 * Translate a Canvas-sized image by `(dx, dy)`, keeping the Canvas size. Content
 * that moves past an edge is dropped; vacated pixels are transparent.
 *
 * This is how a Clip's manual **placement offset** is applied (docs/alignment.md):
 * the offset is a pure translation on top of the automatic Anchor placement, so
 * the bytes the offset was chosen against never change — only where they land.
 */
export function translateOnCanvas(image: RgbaImage, dx: number, dy: number): RgbaImage {
  const data = new Uint8Array(image.width * image.height * 4);
  for (let y = 0; y < image.height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= image.height) {
      continue;
    }
    for (let x = 0; x < image.width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= image.width) {
        continue;
      }
      const from = (sy * image.width + sx) * 4;
      const to = (y * image.width + x) * 4;
      data.set(image.data.subarray(from, from + 4), to);
    }
  }
  return { width: image.width, height: image.height, data };
}
