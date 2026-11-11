/**
 * The Alignment stage: Clips and Drafts ghosted on the shared Canvas.
 *
 * The Canvas, the Anchor and every offset come from the API; this only lays them
 * out so placement is visible. Display pixels per Canvas pixel (`SCALE`) keeps a
 * small Canvas legible.
 */

import type { WorkbenchContext } from './context.js';
import { make } from './dom.js';
import type { PlacementOffset } from '../types.js';

const SCALE = 4;
/**
 * The most a tiny Canvas is blown up.
 *
 * A pixel-art Canvas is often smaller than the stage, and at a fixed rate it would
 * sit there as a stamp while the space around it went unused. Filling the stage is
 * the point of this face, so the rate is a fit with a ceiling rather than a
 * constant.
 */
const SCALE_MAX = 16;

/** Render the alignment board, or the empty state. */
export function alignmentStageView(ctx: WorkbenchContext): HTMLElement {
  const view = make('div', 'stage-view');
  view.dataset.stageView = 'alignment';
  const alignment = ctx.state.alignment;
  if (!alignment) {
    view.dataset.emptyState = 'alignment';
    view.appendChild(
      make('p', 'muted', 'Alignment — select a Character or one of its assets in the Library.'),
    );
    return view;
  }

  const { canvas } = alignment;
  const board = make('div', 'align-board');
  board.dataset.alignmentCanvas = '';
  board.dataset.canvasWidth = String(canvas.width);
  board.dataset.canvasHeight = String(canvas.height);
  // One Canvas pixel is at most SCALE display pixels, and less when the Canvas
  // would not otherwise fit: an oversized board would be clipped by the stage, and
  // with it the very edges a placement is chosen against.
  const scale = fitScale(ctx, canvas);
  board.dataset.alignScale = String(scale);
  board.style.width = `${canvas.width * scale}px`;
  board.style.height = `${canvas.height * scale}px`;

  const anchor = make('span', 'align-anchor');
  anchor.dataset.anchor = '';
  anchor.dataset.anchorX = String(canvas.anchor.x);
  anchor.dataset.anchorY = String(canvas.anchor.y);
  anchor.style.left = `${canvas.anchor.x * scale}px`;
  anchor.style.top = `${canvas.anchor.y * scale}px`;
  board.appendChild(anchor);

  const characterId = ctx.state.activeCharacterId ?? '';
  const addGhost = (label: string, src: string, offset: PlacementOffset | undefined): HTMLElement => {
    const off = offset ?? { x: 0, y: 0 };
    const ghost = make('div', 'align-ghost');
    ghost.dataset.alignGhost = '';
    ghost.dataset.alignLabel = label;
    ghost.dataset.offsetX = String(off.x);
    ghost.dataset.offsetY = String(off.y);
    ghost.style.transform = `translate(${off.x * scale}px, ${off.y * scale}px)`;
    const img = document.createElement('img');
    img.className = 'align-ghost-image';
    img.dataset.alignGhostImage = '';
    img.src = src;
    img.alt = label;
    img.style.width = `${canvas.width * scale}px`;
    img.style.height = `${canvas.height * scale}px`;
    ghost.appendChild(img);
    board.appendChild(ghost);
    return ghost;
  };

  for (const clip of alignment.clips) {
    const ghost = addGhost(clip.id, ctx.api.sheetUrl(characterId, 'clip', clip.id), clip.placementOffset);
    ghost.dataset.kind = 'clip';
    ghost.dataset.asset = clip.id;
  }
  for (const draft of alignment.drafts) {
    const ghost = addGhost(
      draft.id,
      ctx.api.frameUrl(characterId, draft.id, 0),
      draft.placementOffset,
    );
    ghost.dataset.kind = 'draft';
    ghost.dataset.draft = draft.id;
    // A Draft is editable, so its ghost is the handle: drag it to place it. A
    // committed Clip is immutable and only shown (fork it in the inspector).
    makeDraggable(ctx, ghost, characterId, draft.id, scale);
  }

  view.appendChild(board);
  // The rate is a fit, so a resize has to lay the board out again. The listener
  // outlives this render, so it drops itself once the board is gone.
  const refit = (): void => {
    if (!board.isConnected) {
      window.removeEventListener('resize', refit);
      return;
    }
    ctx.renderStage();
  };
  window.addEventListener('resize', refit);
  return view;
}

/**
 * Display pixels per Canvas pixel: as many as fill the stage, up to {@link SCALE_MAX}.
 *
 * Whole numbers while it fits, or the Canvas pixels would be drawn at different
 * sizes; a Canvas too big for the stage drops to a fraction instead of clipping.
 */
function fitScale(ctx: WorkbenchContext, canvas: { width: number; height: number }): number {
  const stage = ctx.regions.stage;
  // Leave the stage's own padding out of the available room.
  const width = stage.clientWidth - 44;
  const height = stage.clientHeight - 42;
  const fit = Math.min(width / canvas.width, height / canvas.height, SCALE_MAX);
  if (!Number.isFinite(fit) || fit <= 0) {
    return SCALE;
  }
  return fit >= 1 ? Math.floor(fit) : Math.max(0.25, fit);
}

/**
 * Let a Draft's ghost be dragged to its placement offset.
 *
 * The offset is a whole-Canvas translation, so the pointer delta is divided by
 * the board scale and rounded: what the ghost shows while dragging is exactly
 * what gets written on release. The write goes through the same guarded path as
 * the inspector's inputs, so a refused offset surfaces like any other action.
 */
function makeDraggable(
  ctx: WorkbenchContext,
  ghost: HTMLElement,
  characterId: string,
  draftId: string,
  scale: number,
): void {
  const image = ghost.querySelector('img');
  if (image) {
    image.draggable = false;
  }
  ghost.classList.add('draggable');

  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;
  let dragging = false;

  ghost.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    baseX = Number(ghost.dataset.offsetX ?? 0);
    baseY = Number(ghost.dataset.offsetY ?? 0);
    capturePointer(ghost, event.pointerId);
    ghost.classList.add('dragging');
  });

  ghost.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return;
    }
    const x = baseX + Math.round((event.clientX - startX) / scale);
    const y = baseY + Math.round((event.clientY - startY) / scale);
    ghost.style.transform = `translate(${x * scale}px, ${y * scale}px)`;
  });

  ghost.addEventListener('pointerup', (event) => {
    if (!dragging) {
      return;
    }
    dragging = false;
    releasePointer(ghost, event.pointerId);
    ghost.classList.remove('dragging');
    const x = baseX + Math.round((event.clientX - startX) / scale);
    const y = baseY + Math.round((event.clientY - startY) / scale);
    void ctx.run('Set offset', () => applyDraggedOffset(ctx, characterId, draftId, { x, y }));
  });

  ghost.addEventListener('pointercancel', () => {
    dragging = false;
    ghost.classList.remove('dragging');
    ghost.style.transform = `translate(${baseX * scale}px, ${baseY * scale}px)`;
  });
}

/**
 * Pointer capture, tolerated where there is no active pointer (jsdom throws on
 * release without one). Capture keeps a drag alive outside the ghost.
 */
function capturePointer(target: HTMLElement, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // no active pointer: the ghosts still track because the events bubble
  }
}

function releasePointer(target: HTMLElement, pointerId: number): void {
  try {
    target.releasePointerCapture(pointerId);
  } catch {
    // nothing was captured
  }
}

/**
 * Persist a dragged offset and re-read what it affects.
 *
 * The warnings come from the server like they do for a typed offset, so a Canvas
 * that moved under the Draft still says so.
 */
async function applyDraggedOffset(
  ctx: WorkbenchContext,
  characterId: string,
  draftId: string,
  offset: PlacementOffset,
): Promise<void> {
  await ctx.api.setPlacementOffset(characterId, draftId, offset);
  const alignment = await ctx.api.readDraftAlignment(characterId, draftId);
  ctx.state.alignmentWarnings = alignment.warnings;
  ctx.state.alignment = await ctx.api.readCharacterAlignment(characterId);
  ctx.renderStage();
  ctx.renderInspector();
}
