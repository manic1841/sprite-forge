/**
 * `createCharacter` — create a Character and its shared Canvas/Anchor.
 *
 * A **Character** is the subject an Asset depicts and the owner of that subject's
 * shared **Canvas** (frame size) and **Anchor** (the pixel reference point used to
 * place the subject). Both live in `characters/<character-id>/canvas.json`
 * (format-spec §3).
 *
 * The Anchor is the first frame's content-box **bottom-centre** — the foot base —
 * and the Canvas is horizontally symmetric about it with the Anchor on the bottom
 * edge: `anchor.x == width / 2` and `anchor.y == height` (Rule 3.1). Because the
 * canvas is symmetric, a `flipX` draw stays aligned and needs no extra offset.
 *
 * Frame size is **always** the Character's Canvas: a Clip or Sequence never stores
 * its own (Rule 3.2), so every Asset of a Character can be swapped without the
 * subject jumping.
 */

import { StoreError } from './errors.js';
import { isValidId } from './ids.js';
import { canvasPath, characterDir } from './layout.js';
import { writeJsonFile } from './store/index.js';
import { validateArtifact } from './validate.js';

/** A point in Canvas pixel coordinates (origin top-left, `+y` down). */
export interface CanvasAnchor {
  /** Must equal `width / 2` (the Canvas is symmetric about the Anchor). */
  x: number;
  /** Must equal `height` (the Anchor sits on the bottom edge). */
  y: number;
}

/** The frame size and Anchor shared by every Asset of a Character. */
export interface Canvas {
  width: number;
  height: number;
  anchor: CanvasAnchor;
}

/** Inputs for {@link createCharacter}. */
export interface CreateCharacterOptions {
  /** Caller-assigned Character id; validated against the id grammar. Becomes the folder name. */
  characterId: string;
  /** Canvas width in pixels; must be a positive even integer so `anchor.x` is an integer. */
  width: number;
  /** Canvas height in pixels; must be a positive integer. */
  height: number;
  /** The foot-base Anchor; must satisfy the invariant enforced below. */
  anchor: CanvasAnchor;
}

/** The Character as created by {@link createCharacter}. */
export interface CreatedCharacter {
  /** The Character id (its folder name). */
  id: string;
  /** Store-relative POSIX directory. */
  dir: string;
  /** The Canvas/Anchor as written to `canvas.json`. */
  canvas: Canvas;
}

/**
 * Create a Character, writing its Character-level `canvas.json`.
 *
 * The id grammar and the Anchor invariant are both **hard errors**: nothing is
 * written unless the Canvas is valid, so the store never holds a half-created
 * Character with a broken Canvas.
 */
export async function createCharacter(
  root: string,
  options: CreateCharacterOptions,
): Promise<CreatedCharacter> {
  const { characterId, width, height, anchor } = options;

  // The id becomes the folder name, so it must satisfy the id grammar before
  // anything touches the store.
  if (!isValidId(characterId)) {
    throw new StoreError(
      `Invalid character id "${characterId}": must match /^[a-z][a-z0-9-]*$/.`,
    );
  }

  // Rule 3.1 needs `anchor.x == width / 2`; an odd width has no integer centre, so
  // reject it explicitly rather than silently truncating the Anchor.
  if (!Number.isInteger(width) || width < 1 || width % 2 !== 0) {
    throw new StoreError(
      `Canvas width must be a positive even integer so the Anchor can sit at its ` +
        `integer centre (anchor.x == width/2); got ${width}.`,
    );
  }

  const canvas: Canvas = { width, height, anchor: { x: anchor.x, y: anchor.y } };

  // The schema closes the object and checks the shapes; the cross-artifact rule
  // enforces the Anchor invariant (Rule 3.1) that JSON Schema cannot express.
  validateArtifact('canvas', canvas);

  await writeJsonFile(root, canvasPath(characterId), canvas);

  return { id: characterId, dir: characterDir(characterId), canvas };
}
