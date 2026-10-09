/**
 * The Recording timeline's range model.
 *
 * Dragging a cut edge in the filmstrip edits a Segment's half-open range
 * `[startFrame, endFrame)` inside the Recording's frame count. The clamping is a
 * pure function over that range — no DOM — so it lives here rather than inside the
 * workbench shell.
 */

import type { Segment } from './types.js';

/** Clamp a drag on a cut edge to a valid half-open range inside the Recording. */
export function clampRange(
  edge: 'start' | 'end',
  frame: number,
  cut: Segment,
  frameCount: number,
): { startFrame: number; endFrame: number } {
  if (edge === 'start') {
    const startFrame = Math.max(0, Math.min(Math.round(frame), cut.endFrame - 1));
    return { startFrame, endFrame: cut.endFrame };
  }
  const endFrame = Math.min(frameCount, Math.max(Math.round(frame), cut.startFrame + 1));
  return { startFrame: cut.startFrame, endFrame };
}
