/**
 * The Canvas edges as drag handles: the board's border is the resize control.
 *
 * A resize is Character-wide arithmetic (`resizeCanvas`), so a drag here is a
 * **preview** of exactly that arithmetic — the board, the Anchor and every ghost
 * move by the delta the store would apply — followed by a single write on
 * release. The preview and the write share one formula, so letting go never
 * jumps.
 *
 * The drag cannot produce a size the store would refuse: the content floor and
 * the even-width rule are clamped here, not rejected afterwards. Because the
 * Canvas stays symmetric about the Anchor, a width drag adds the same amount to
 * both sides (two Canvas columns per Canvas column dragged) and the content
 * shifts with it; a height drag adds rows above, which is why the top edge grows
 * upward too.
 */

import type { WorkbenchApi } from '../api.js';
import type { WorkbenchState } from './state.js';
import type { Canvas, ContentFloor } from '../types.js';
import { make } from './dom.js';

/** What the grips need: the write, the state, and the two repaints it triggers. */
export interface CanvasGripDeps {
  readonly api: WorkbenchApi;
  readonly state: WorkbenchState;
  run(label: string, body: () => Promise<void>): void;
  renderStage(): void;
  renderInspector(): void;
}

/** A drawn edge: which axis it moves, and which direction grows the Canvas. */
interface Grip {
  edge: 'left' | 'right' | 'top' | 'bottom';
  axis: 'x' | 'y';
  /** Multiplier taking the pointer's movement to the Canvas' growth. */
  sign: 1 | -1;
  label: string;
  hint: string;
}

const GRIPS: readonly Grip[] = [
  {
    edge: 'left',
    axis: 'x',
    sign: -1,
    label: 'Resize Canvas width from the left edge',
    hint: 'drag, or arrow left/right',
  },
  {
    edge: 'right',
    axis: 'x',
    sign: 1,
    label: 'Resize Canvas width from the right edge',
    hint: 'drag, or arrow left/right',
  },
  {
    edge: 'top',
    axis: 'y',
    sign: -1,
    label: 'Resize Canvas height from the top edge',
    hint: 'drag, or arrow up/down',
  },
  {
    edge: 'bottom',
    axis: 'y',
    sign: 1,
    label: 'Resize Canvas height from the bottom edge',
    hint: 'drag, or arrow up/down',
  },
];

/** The handles for one board, laid over its every edge. */
export interface CanvasGripsOptions {
  characterId: string;
  canvas: Canvas;
  floor: ContentFloor;
  /** Display pixels per Canvas pixel, so pointer pixels read back as Canvas pixels. */
  scale: number;
  /** The board itself: whose size the preview rewrites. */
  board: HTMLElement;
  /** The size readout under the board: the preview's number. */
  readout: HTMLElement;
}

/**
 * Build the four grips for a board.
 *
 * Each is a real button, so the size is reachable without a pointer: the arrow
 * keys move the edge the same way a drag would, in whole Canvas columns of two.
 */
export function canvasGrips(ctx: CanvasGripDeps, options: CanvasGripsOptions): HTMLElement {
  const { characterId, canvas, floor, scale, board, readout } = options;
  const limits = smallestSize(floor);
  const anchor = board.querySelector<HTMLElement>('[data-anchor]');
  const ghosts = [...board.querySelectorAll<HTMLElement>('[data-align-ghost]')];
  const plate = make('div', 'align-grips');

  for (const grip of GRIPS) {
    const button = make('button', `align-grip align-grip-${grip.axis}`) as HTMLButtonElement;
    button.dataset.canvasGrip = grip.axis;
    button.dataset.gripEdge = grip.edge;
    button.setAttribute('aria-label', `${grip.label} (${grip.hint})`);
    button.title = `${grip.label} — ${grip.hint}`;
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      drag(ctx, {
        characterId,
        canvas,
        floor,
        limits,
        scale,
        board,
        readout,
        anchor,
        ghosts,
        grip,
        event,
      });
    });
    button.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 8 : 1;
      const delta = keyDelta(grip, event.key, step);
      if (delta === 0) {
        return;
      }
      event.preventDefault();
      const size = sizeFor(canvas, limits, grip.axis, delta);
      if (!changed(canvas, size)) {
        return;
      }
      commit(ctx, characterId, size);
    });
    plate.appendChild(button);
  }
  return plate;
}

/** The smallest Canvas the drag may reach: the content floor, never below 2×1. */
function smallestSize(floor: ContentFloor): { width: number; height: number } {
  return {
    // The width is always even (the Anchor is its integer centre), so an odd floor
    // rounds up rather than being refused.
    width: Math.max(2, floor.width + (floor.width % 2)),
    height: Math.max(1, floor.height),
  };
}

/**
 * The size one edge movement asks for, clamped to what the store will take.
 *
 * `delta` is in Canvas pixels along the Canvas' growth, so a width move counts
 * double: the Canvas grows on both sides of the Anchor at once.
 */
function sizeFor(
  canvas: Canvas,
  limits: { width: number; height: number },
  axis: 'x' | 'y',
  delta: number,
): { width: number; height: number } {
  return {
    width: clamp(axis === 'x' ? canvas.width + delta * 2 : canvas.width, limits.width),
    height: clamp(axis === 'y' ? canvas.height + delta : canvas.height, limits.height),
  };
}

function changed(canvas: Canvas, size: { width: number; height: number }): boolean {
  return size.width !== canvas.width || size.height !== canvas.height;
}

/** Whole columns the arrow key asks for, signed by which way the edge travels. */
function keyDelta(grip: Grip, key: string, step: number): number {
  if (grip.axis === 'x') {
    if (key === 'ArrowLeft') {
      return step;
    }
    return key === 'ArrowRight' ? -step : 0;
  }
  if (key === 'ArrowUp') {
    return step;
  }
  return key === 'ArrowDown' ? -step : 0;
}

function clamp(value: number, min: number): number {
  return value < min ? min : value;
}

/** One pointer drag: preview on move, write once on release. */
function drag(
  ctx: CanvasGripDeps,
  options: CanvasGripsOptions & {
    limits: { width: number; height: number };
    anchor: HTMLElement | null;
    ghosts: HTMLElement[];
    grip: Grip;
    event: PointerEvent;
  },
): void {
  const { characterId, canvas, limits, scale, board, readout, anchor, ghosts, grip } = options;
  const startX = options.event.clientX;
  const startY = options.event.clientY;
  const plate = board.parentElement;
  let size = { width: canvas.width, height: canvas.height };

  const pointed = (event: PointerEvent): number => {
    const moved = grip.axis === 'x' ? event.clientX - startX : event.clientY - startY;
    return Math.round((moved * grip.sign) / scale);
  };

  const move = (event: PointerEvent): void => {
    size = sizeFor(canvas, limits, grip.axis, pointed(event));
    preview({ canvas, scale, board, readout, anchor, ghosts }, size);
  };

  const up = (event: PointerEvent): void => {
    stop();
    releasePointer(board, event.pointerId);
    plate?.classList.remove('is-resizing');
    if (changed(canvas, size)) {
      commit(ctx, characterId, size);
    } else {
      // A drag that came back to where it started leaves nothing to write, but the
      // preview is still on screen and has to be the store's again.
      ctx.renderStage();
    }
  };

  const cancel = (): void => {
    stop();
    plate?.classList.remove('is-resizing');
    ctx.renderStage();
  };

  const stop = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
  };

  capturePointer(board, options.event.pointerId);
  plate?.classList.add('is-resizing');
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

/**
 * Draw the store's own arithmetic without writing it: the frame's edge moves, the
 * Anchor follows, and every ghost is translated by the delta a re-bake would apply.
 *
 * The picture keeps the pixel size it is drawn at and is shifted by the same delta,
 * so it stays still on screen while the area around it grows. Sizing the image to
 * the new box instead would stretch the bitmap the browser already has, which reads
 * as the sprite being blown up rather than as empty canvas being added.
 *
 * The rate is held, so one screen pixel is always the same pointer pixel and the
 * edge tracks the pointer exactly.
 */
function preview(
  scene: {
    canvas: Canvas;
    scale: number;
    board: HTMLElement;
    readout: HTMLElement;
    anchor: HTMLElement | null;
    ghosts: HTMLElement[];
  },
  size: { width: number; height: number },
): void {
  const { canvas, scale, board, readout, anchor, ghosts } = scene;
  const dx = (size.width - canvas.width) / 2;
  const dy = size.height - canvas.height;

  board.style.width = `${size.width * scale}px`;
  board.style.height = `${size.height * scale}px`;
  if (anchor) {
    anchor.style.left = `${(size.width / 2) * scale}px`;
    anchor.style.top = `${size.height * scale}px`;
  }
  for (const ghost of ghosts) {
    const offsetX = Number(ghost.dataset.offsetX ?? 0);
    const offsetY = Number(ghost.dataset.offsetY ?? 0);
    // The box grows so the extra area is visible; the box clips whatever a smaller
    // Canvas would cut off. The box stays at the Canvas origin, so the ghost is
    // translated by the Draft's offset alone — exactly as it is at rest.
    ghost.style.width = `${size.width * scale}px`;
    ghost.style.height = `${size.height * scale}px`;
    ghost.style.transform = `translate(${offsetX * scale}px, ${offsetY * scale}px)`;
    // The bitmap is still the old size; it is shifted by the delta the re-bake will
    // apply so its pixels sit where they will sit afterwards.
    const image = ghost.querySelector<HTMLElement>('[data-align-ghost-image]');
    if (image) {
      image.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
    }
  }
  readout.textContent = `${size.width} × ${size.height}`;
}

/** Write the size once and re-read what it re-baked. */
function commit(
  ctx: CanvasGripDeps,
  characterId: string,
  size: { width: number; height: number },
): void {
  ctx.run('Resize canvas', async () => {
    await ctx.api.resizeCanvas(characterId, size.width, size.height);
    ctx.state.alignmentWarnings = [];
    ctx.state.alignment = await ctx.api.readCharacterAlignment(characterId);
    // The expand inputs follow the Canvas until they are edited.
    ctx.state.resizeWidth = ctx.state.alignment.canvas.width;
    ctx.state.resizeHeight = ctx.state.alignment.canvas.height;
    ctx.renderStage();
    ctx.renderInspector();
  });
}

/**
 * Pointer capture, tolerated where there is no active pointer (jsdom throws on
 * release without one). It keeps a drag alive across the board's edge, which a
 * resize constantly crosses.
 */
function capturePointer(target: HTMLElement, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // no active pointer: the window listeners still receive the events
  }
}

function releasePointer(target: HTMLElement, pointerId: number): void {
  try {
    target.releasePointerCapture(pointerId);
  } catch {
    // nothing was captured
  }
}
