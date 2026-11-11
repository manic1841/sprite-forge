/**
 * Sizing and zooming the Draft sheet.
 *
 * Repair is pixel work, so the frame has to be shown at whole, explicit screen
 * pixels per image pixel — a fractional fit would put image pixels at different
 * sizes and there would be no pixel to aim the brush at. This module owns that
 * rate, the grid layer, and the controls that change it.
 */

import { make } from './dom.js';
import type { WorkbenchState } from './state.js';

/** One zoom step, and the ceiling, in screen pixels per image pixel. */
export const DRAFT_ZOOM_STEP = 2;
export const DRAFT_ZOOM_MAX = 32;

/** What sizing needs of the shell: the zoom choice and the stage to measure. */
export interface SheetDeps {
  readonly state: WorkbenchState;
  readonly regions: { stage: HTMLElement };
  renderStage(): void;
}

/**
 * Screen pixels per image pixel: the explicit zoom, or the largest whole fit.
 *
 * A fitted view floors to a whole number so image pixels stay equal on screen;
 * the floor is 1 so a frame never shrinks below its own pixels. The room is
 * measured on the stage rather than on the board, because the board is sized
 * *by* the sheet and so cannot say how much space it has before the frame is
 * placed (a small frame would fit itself to its own natural size and stay a
 * stamp).
 */
export function draftScaleFor(deps: SheetDeps, board: HTMLElement, img: HTMLImageElement): number {
  // A zoom the operator set is honoured even before the frame decodes: the fit is
  // the only thing that needs a size to divide.
  if (deps.state.draftZoom !== null) {
    return deps.state.draftZoom;
  }
  const width = img.naturalWidth || 0;
  const height = img.naturalHeight || 0;
  if (width === 0 || height === 0) {
    return 1;
  }
  const stage = deps.regions.stage;
  // The board is the frame's own box, but it is detached while the stage is
  // being built, so the stage it will sit in stands in for it until then.
  const room = board.clientWidth || Math.max(0, stage.clientWidth - 110);
  const heightRoom = board.clientHeight || Math.max(0, stage.clientHeight - 150);
  if (room === 0 || heightRoom === 0) {
    return 1;
  }
  const fit = Math.min(room / width, heightRoom / height);
  return Math.max(1, Math.min(DRAFT_ZOOM_MAX, Math.floor(fit)));
}

/** Keep the zoom inside a whole number of screen pixels per image pixel. */
export function clampDraftZoom(scale: number): number {
  return Math.min(DRAFT_ZOOM_MAX, Math.max(1, Math.round(scale)));
}

/**
 * Size the sheet from the frame's own pixels times the zoom.
 *
 * The image is stretched to its natural size instead of being fitted by the
 * stage. At the fitting zoom the sheet is smaller than the board, so the board's
 * `auto` margin centres it; past it, it scrolls.
 */
export function applySheetSize(
  deps: SheetDeps,
  board: HTMLElement,
  sheet: HTMLElement,
  img: HTMLImageElement,
  label: HTMLElement,
): void {
  const set = (): boolean => {
    const scale = draftScaleFor(deps, board, img);
    // The label is honest even before the frame decodes, so it is written first:
    // the zoom is a choice, not a measurement.
    label.textContent = `${scale}×`;
    label.classList.toggle('is-fitted', deps.state.draftZoom === null);
    // `naturalWidth` is 0 until the frame decodes, so the box waits for it.
    if (img.naturalWidth === 0) {
      return false;
    }
    sheet.style.width = `${img.naturalWidth * scale}px`;
    sheet.style.height = `${img.naturalHeight * scale}px`;
    // The pixel grid is a CSS layer, not canvas strokes: at a hairline width two
    // thousand strokes would wash the whole frame grey. It appears only once a
    // pixel is wide enough to aim at.
    sheet.style.setProperty('--px', `${scale}px`);
    sheet.classList.toggle('is-grid', scale >= 8);
    return true;
  };
  // A cached frame can be `complete` before it has decoded, so the load handler
  // is always armed until a size has actually been written.
  if (!set()) {
    img.addEventListener('load', set, { once: true });
  }
}

/** `−  1×  +  Fit`, beside the counter. */
export function zoomControls(
  deps: SheetDeps,
  board: HTMLElement,
  img: HTMLImageElement,
): { group: HTMLElement; label: HTMLElement } {
  const group = make('span', 'draft-zoom');
  group.dataset.draftZoomControls = '';

  const step = (factor: number): HTMLButtonElement => {
    const zoomIn = factor > 0;
    const button = make('button', 'btn small ghost', zoomIn ? '+' : '−') as HTMLButtonElement;
    button.dataset.draftZoomStep = String(factor);
    button.setAttribute('aria-label', zoomIn ? 'Zoom in' : 'Zoom out');
    button.addEventListener('click', () => {
      const scale = draftScaleFor(deps, board, img);
      deps.state.draftZoom = clampDraftZoom(
        zoomIn ? scale * DRAFT_ZOOM_STEP : scale / DRAFT_ZOOM_STEP,
      );
      deps.renderStage();
    });
    return button;
  };

  const fit = make('button', 'btn small ghost', 'Fit') as HTMLButtonElement;
  fit.dataset.draftZoomFit = '';
  fit.addEventListener('click', () => {
    deps.state.draftZoom = null;
    deps.renderStage();
  });

  const label = make('span', 'draft-zoom-label');
  label.dataset.draftZoomLabel = '';

  group.append(step(-1), label, step(1), fit);
  return { group, label };
}

/**
 * Ctrl + wheel to zoom, anchored on the pointer.
 *
 * Zooming out to the fit means "show me all of it", which is a different intent
 * from a step, so it hands the scale back to the fit rather than stopping at 1×.
 */
export function attachDraftZoom(
  deps: SheetDeps,
  board: HTMLElement,
  sheet: HTMLElement,
  img: HTMLImageElement,
): void {
  board.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      const from = draftScaleFor(deps, board, img);
      const to =
        event.deltaY < 0
          ? clampDraftZoom(from * DRAFT_ZOOM_STEP)
          : clampDraftZoom(from / DRAFT_ZOOM_STEP);
      if (to === from) {
        return;
      }
      // Hold the pixel under the cursor still, in board coordinates.
      const sheetRect = sheet.getBoundingClientRect();
      const anchorX = (event.clientX - sheetRect.left) / (sheetRect.width || 1);
      const anchorY = (event.clientY - sheetRect.top) / (sheetRect.height || 1);
      deps.state.draftZoom = to;
      deps.renderStage();

      const liveBoard = deps.regions.stage.querySelector<HTMLElement>('[data-draft-board]');
      const liveSheet = deps.regions.stage.querySelector<HTMLElement>('[data-draft-sheet]');
      if (!liveBoard || !liveSheet) {
        return;
      }
      const next = liveSheet.getBoundingClientRect();
      liveBoard.scrollLeft += next.left + next.width * anchorX - event.clientX;
      liveBoard.scrollTop += next.top + next.height * anchorY - event.clientY;
    },
    { passive: false },
  );
}

/** Keep the stage sized on a resize: the fit is the only size that reads room. */
export function refitOnResize(
  deps: SheetDeps,
  img: HTMLImageElement,
  fit: () => void,
): void {
  const refit = (): void => {
    if (!img.isConnected) {
      window.removeEventListener('resize', refit);
      return;
    }
    fit();
  };
  window.addEventListener('resize', refit);
}

/** The old name for what a fit reads of the shell; kept because tests name it. */
export type FitContext = SheetDeps;
