/**
 * The Alignment stage: Clips and Drafts ghosted on the shared Canvas.
 *
 * The Canvas, the Anchor and every offset come from the API; this only lays them
 * out so placement is visible. Display pixels per Canvas pixel (`SCALE`) keeps a
 * small Canvas legible.
 */

import type { AlignStagePort } from './ports.js';
import { make } from './dom.js';
import { canvasGrips } from './canvasGrips.js';
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
export function alignmentStageView(ctx: AlignStagePort): HTMLElement {
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
  // Resizing is a Canvas gesture, so the board is the thing being grabbed.
  board.dataset.alignmentCanvas = '';
  board.dataset.canvasWidth = String(canvas.width);
  board.dataset.canvasHeight = String(canvas.height);
  // The display rate is **held** across renders. A resize is a change of Canvas
  // area, not a zoom: the frame's edges move and the picture stays exactly as big
  // as it was, so growing reveals empty margin and shrinking cuts pixels away.
  // Refitting every render would rescale the sprite under the pointer instead.
  //
  // The rate is a whole number of screen pixels, so no Canvas pixel is ever
  // resampled; a board that outgrows the stage keeps the rate and scrolls. Only a
  // window resize refits, since that is a change of the room rather than of the
  // Canvas.
  const scale = ctx.state.alignScale ?? fitScale(ctx, canvas);
  ctx.state.alignScale = scale;
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
  const addGhost = (
    label: string,
    src: string,
    offset: PlacementOffset | undefined,
    frameCount = 1,
  ): HTMLElement => {
    const off = offset ?? { x: 0, y: 0 };
    const ghost = make('div', 'align-ghost');
    ghost.dataset.alignGhost = '';
    ghost.dataset.alignLabel = label;
    ghost.dataset.offsetX = String(off.x);
    ghost.dataset.offsetY = String(off.y);
    // The ghost box is the Clip's own frames, not the Canvas: the Canvas frame around
    // it can be dragged larger, and the picture has to keep its pixel size inside it.
    ghost.style.transform = `translate(${off.x * scale}px, ${off.y * scale}px)`;
    // A ghost is one Canvas, so a sheet with several frames is shown as its first
    // frame: the image is laid out `frameCount` Canvases wide and the ghost clips
    // the rest.
    ghost.style.width = `${canvas.width * scale}px`;
    ghost.style.height = `${canvas.height * scale}px`;
    ghost.style.overflow = 'hidden';
    const img = document.createElement('img');
    img.className = 'align-ghost-image';
    img.dataset.alignGhostImage = '';
    img.src = src;
    img.alt = label;
    img.style.width = `${canvas.width * scale * frameCount}px`;
    img.style.height = `${canvas.height * scale}px`;
    ghost.appendChild(img);
    board.appendChild(ghost);
    return ghost;
  };

  for (const clip of alignment.clips) {
    const ghost = addGhost(
      clip.id,
      ctx.api.sheetUrl(characterId, 'clip', clip.id),
      clip.placementOffset,
      clip.frameCount,
    );
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
    // A Draft's stored frame is unflipped (Repair is authored on it), so the mirror
    // is shown here instead — only on the picture, never on the box, so the drag
    // maths stay in box space.
    const ghostImage = ghost.querySelector<HTMLImageElement>('[data-align-ghost-image]');
    if (draft.flipX && ghostImage) {
      ghostImage.classList.add('is-mirrored');
    }
    // A Draft is editable, so its ghost is the handle: drag it to place it. A
    // committed Clip is immutable and only shown (fork it in the inspector).
    makeDraggable(ctx, ghost, characterId, draft.id, scale);
  }

  // Its size in Canvas pixels, under the board: a resize changes a number, and the
  // number is the honest record of a crop.
  const size = make('p', 'align-size-readout', `${canvas.width} × ${canvas.height}`);
  size.dataset.alignSizeReadout = '';

  // The board sits on a plate so its edges can be grabbed: the board clips its own
  // overflow, so handles inside it would be cut in half. A committed Asset's
  // Canvas is not edited from here (fork instead), so only the editable faces get
  // them.
  const plate = make('div', 'align-plate');
  plate.appendChild(board);
  if (ctx.state.target.kind !== 'asset') {
    plate.appendChild(
      canvasGrips(ctx, {
        characterId,
        canvas,
        floor: alignment.contentFloor,
        scale,
        board,
        readout: size,
      }),
    );
  }

  const frame = make('div', 'align-frame');
  frame.append(plate, size);
  view.appendChild(frame);
  // The rate is held, so only a change of room (a window resize) refits it. The
  // listener outlives this render, so it drops itself once the board is gone.
  const refit = (): void => {
    if (!frame.isConnected) {
      window.removeEventListener('resize', refit);
      return;
    }
    ctx.state.alignScale = null;
    ctx.renderStage();
  };
  window.addEventListener('resize', refit);
  return view;
}

/**
 * Display pixels per Canvas pixel: as many whole pixels as fill the stage, up to
 * {@link SCALE_MAX}, and never fewer than one.
 *
 * The rate is always an **integer**, so every Canvas pixel is a whole block of
 * screen pixels and nothing is resampled. A Canvas too big for the stage keeps 1×
 * and crops instead of shrinking to a fraction.
 */
function fitScale(ctx: AlignStagePort, canvas: { width: number; height: number }): number {
  const stage = ctx.regions.stage;
  // Leave the stage's own padding out of the available room.
  const width = stage.clientWidth - 44;
  const height = stage.clientHeight - 42;
  const fit = Math.min(width / canvas.width, height / canvas.height, SCALE_MAX);
  if (!Number.isFinite(fit) || fit < 1) {
    return 1;
  }
  return Math.floor(fit);
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
  ctx: AlignStagePort,
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
  ctx: AlignStagePort,
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
