/**
 * The Cutting face: a Recording's frames.
 *
 * This is its own face because a Segment only exists inside a Recording — an
 * unrelated idea while repairing a Draft. The stage only shows the frame; the
 * filmstrip below picks the range and the inspector edits the selected Segment.
 * Every range rule behind those gestures belongs to the cut session.
 */

import type { CutStagePort } from './ports.js';
import { make } from './dom.js';
import type { Bounds } from '../types.js';

/** Render the cut face for the loaded Recording. */
export function cutStageView(ctx: CutStagePort): HTMLElement {
  const view = make('div', 'stage-view');
  view.dataset.stageView = 'cut';

  const recordingId = ctx.state.recordingId;
  const cutList = ctx.state.cutList;
  if (ctx.state.target.kind !== 'recording' || !recordingId || !cutList) {
    view.dataset.emptyState = 'cut';
    view.appendChild(
      make('p', 'muted', 'Open a Recording from the Library to cut it into Segments.'),
    );
    return view;
  }

  const preview = make('div', 'recording-viewer');
  preview.dataset.recordingViewer = '';
  preview.dataset.recording = recordingId;
  preview.dataset.activeFrame = String(ctx.state.frame);

  const prev = make('button', 'btn ghost', '◀') as HTMLButtonElement;
  prev.dataset.frameStep = 'prev';
  prev.disabled = ctx.state.frame <= 0;
  prev.addEventListener('click', () => stepFrame(ctx, -1));

  const img = document.createElement('img');
  img.className = 'recording-frame';
  img.dataset.recordingFrame = '';
  img.dataset.frameIndex = String(ctx.state.frame);
  img.src = ctx.api.recordingFrameUrl(recordingId, ctx.state.frame);
  img.alt = `${recordingId} frame ${ctx.state.frame}`;
  fitRecordingFrame(ctx, img);

  // The box lives on the selected Segment, so it is drawn on the frame only while
  // one is selected: it is that Segment's window, not the Recording's. The layer
  // is a sibling placed over the image; dragging anywhere on the frame draws.
  const holder = make('div', 'cut-frame');
  holder.append(img);
  const selected = (cutList.cuts ?? []).find((cut) => cut.id === ctx.state.selectedCut);
  if (selected) {
    const box = make('div', 'cut-box');
    box.dataset.cutBox = selected.id;
    // The image may not have decoded yet, so the box is positioned again on load
    // rather than only here (its percentages need the natural size).
    const place = (): void => placeBox(box, selected.rect, img);
    place();
    img.addEventListener('load', place);
    // The ghost follows the pointer during a drag, before anything is written.
    const ghost = make('div', 'cut-box-ghost');
    ghost.dataset.cutBoxGhost = '';
    ghost.hidden = true;
    holder.append(box, ghost);
    holder.dataset.drawBox = '';
    holder.addEventListener('pointerdown', (event) => {
      ghost.hidden = false;
      ctx.cut.beginBox(selected.id, holder, event);
    });
  }

  const next = make('button', 'btn ghost', '▶') as HTMLButtonElement;
  next.dataset.frameStep = 'next';
  next.disabled = ctx.state.frame >= cutList.frameCount - 1;
  next.addEventListener('click', () => stepFrame(ctx, 1));

  const counter = make('span', 'pill');
  counter.dataset.recordingFrameCounter = '';
  counter.textContent = `frame ${ctx.state.frame} / ${cutList.frameCount}`;

  const row = make('div', 'draft-stage');
  row.append(prev, holder, next);
  preview.append(row, counter);
  view.appendChild(preview);
  return view;
}

/** How far a small frame is blown up on the preview, in screen px per image px. */
const PREVIEW_SCALE_MAX = 16;

/**
 * Place a box layer over the frame, as percentages of the frame's own pixels.
 *
 * Percentages rather than screen pixels keep the box correct at any preview
 * scale, including the scale the fit picks when the stage is resized.
 */
function placeBox(layer: HTMLElement, rect: Bounds | undefined, img?: HTMLImageElement): void {
  const image = img ?? (layer.parentElement?.querySelector('img') as HTMLImageElement | null);
  // The laid-out size stands in until the frame has decoded (and in a DOM-only
  // environment that never decodes it), so the box is still truthful.
  const laidOut = image?.getBoundingClientRect();
  const width = image?.naturalWidth || Math.round(laidOut?.width ?? 0);
  const height = image?.naturalHeight || Math.round(laidOut?.height ?? 0);
  if (!rect || width <= 0 || height <= 0) {
    layer.hidden = rect === undefined;
    layer.style.left = '';
    layer.style.top = '';
    layer.style.width = '';
    layer.style.height = '';
    return;
  }
  layer.hidden = false;
  layer.dataset.box = `${rect.x},${rect.y},${rect.width},${rect.height}`;
  layer.style.left = `${(rect.x / width) * 100}%`;
  layer.style.top = `${(rect.y / height) * 100}%`;
  layer.style.width = `${(rect.width / width) * 100}%`;
  layer.style.height = `${(rect.height / height) * 100}%`;
}

/**
 * Grows a small frame to the space there is, up to {@link PREVIEW_SCALE_MAX}.
 *
 * Recording frames are often only a few dozen pixels across, and at their natural
 * size they read as a stamp in the middle of the stage. The rate is a fit with a
 * ceiling and whole numbers, so pixel art stays square.
 */
function fitRecordingFrame(ctx: CutStagePort, img: HTMLImageElement): void {
  const size = (): boolean => {
    const width = ctx.regions.stage.clientWidth - 96;
    const height = ctx.regions.stage.clientHeight - 42;
    if (!img.naturalWidth || width <= 0 || height <= 0) {
      return false;
    }
    const fit = Math.min(width / img.naturalWidth, height / img.naturalHeight, PREVIEW_SCALE_MAX);
    const scale = fit >= 1 ? Math.floor(fit) : Math.max(0.25, fit);
    img.style.width = `${img.naturalWidth * scale}px`;
    img.style.height = `${img.naturalHeight * scale}px`;
    return true;
  };
  if (!size()) {
    // Not decoded yet, so there is no natural size to scale from.
    img.addEventListener('load', () => size(), { once: true });
  }
  // The preview follows the stage, and a resize changes it. The listener drops
  // itself once the frame is gone.
  const refit = (): void => {
    if (!img.isConnected) {
      window.removeEventListener('resize', refit);
      return;
    }
    size();
  };
  window.addEventListener('resize', refit);
}

function stepFrame(ctx: CutStagePort, delta: number): void {
  const frameCount = ctx.state.cutList?.frameCount ?? 0;
  if (frameCount === 0) {
    return;
  }
  // Stepping by hand is a scrub, so it takes over from playback and carries the
  // Segment the frame lands in.
  const next = Math.max(0, Math.min(frameCount - 1, ctx.state.frame + delta));
  ctx.cut.scrubTo(next);
  ctx.renderStage();
  ctx.renderFilmstrip();
  ctx.renderContext();
  ctx.renderInspector();
}
