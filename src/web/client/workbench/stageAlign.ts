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
  board.style.width = `${canvas.width * SCALE}px`;
  board.style.height = `${canvas.height * SCALE}px`;

  const anchor = make('span', 'align-anchor');
  anchor.dataset.anchor = '';
  anchor.dataset.anchorX = String(canvas.anchor.x);
  anchor.dataset.anchorY = String(canvas.anchor.y);
  anchor.style.left = `${canvas.anchor.x * SCALE}px`;
  anchor.style.top = `${canvas.anchor.y * SCALE}px`;
  board.appendChild(anchor);

  const characterId = ctx.state.activeCharacterId ?? '';
  const addGhost = (label: string, src: string, offset: PlacementOffset | undefined): HTMLElement => {
    const off = offset ?? { x: 0, y: 0 };
    const ghost = make('div', 'align-ghost');
    ghost.dataset.alignGhost = '';
    ghost.dataset.alignLabel = label;
    ghost.dataset.offsetX = String(off.x);
    ghost.dataset.offsetY = String(off.y);
    ghost.style.transform = `translate(${off.x * SCALE}px, ${off.y * SCALE}px)`;
    const img = document.createElement('img');
    img.className = 'align-ghost-image';
    img.dataset.alignGhostImage = '';
    img.src = src;
    img.alt = label;
    img.style.width = `${canvas.width * SCALE}px`;
    img.style.height = `${canvas.height * SCALE}px`;
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
  }

  view.appendChild(board);
  return view;
}
