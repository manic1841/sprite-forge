/**
 * The filmstrip: the loaded Recording as a frame-accurate scrubber.
 *
 * The frame index is the unit. Cut ranges are drawn as draggable bands over the
 * same track; what a drag *means* is the cut session's business — this module
 * only builds the cells and bands and hands the gestures over. Playback paints
 * the playhead in place; the strip itself is never rebuilt for a tick.
 */

import type { FilmstripPort } from './ports.js';
import { make } from './dom.js';
import { renderSelectionActions, rangeLabel } from './cutSession.js';
import type { Segment } from '../types.js';

/** The narrowest a frame cell is drawn, in px, before zoom starts scrolling. */
const CELL_PX = 18;
/** The space held between two cells; also part of the strip's width budget. */
const GAP_PX = 2;
/** How much one Ctrl + wheel notch multiplies the time axis. */
const ZOOM_STEP = 1.3;
const ZOOM_MAX = 8;

/** Render the whole strip from the loaded cut list. */
export function renderFilmstrip(ctx: FilmstripPort): void {
  const { filmstrip } = ctx.regions;
  const { state } = ctx;
  filmstrip.innerHTML = '';
  filmstrip.dataset.activeFrame = String(state.frame);

  const header = make('div', 'filmstrip-header transport-head');
  header.dataset.filmstripHeader = '';
  const title = make('span', 'ttl transport-title');
  title.textContent = state.recordingId
    ? `Recording — ${state.recordingId}`
    : 'Recording — none loaded';
  const sub = make('span', 'muted transport-note');
  sub.textContent = state.cutList
    ? `${frameCounter(state.frame, state.cutList.frameCount, state.cutList.cuts.length)}`
    : 'load a Recording to scrub its frames';

  // The strip carries its own action area: the counter, the verbs a marked range
  // offers, and Play — which is what checks the range before it is kept.
  const controls = make('span', 'filmstrip-controls transport-actions');
  controls.dataset.filmstripControls = '';
  controls.append(sub);
  if (state.selection) {
    controls.appendChild(renderSelectionActions(ctx.cutDeps));
  }
  controls.appendChild(playButton(ctx));
  header.append(title, controls);

  // The frames and the track scroll as one block: they are two views of the same
  // frame axis, so they must move together. The block is as wide as the zoom says,
  // and at 1× exactly as wide as the strip.
  const frameCount = state.cutList?.frameCount ?? 0;
  const isFit = state.trackZoom === 1;
  const scroller = make('div', 'strip-scroll');
  scroller.dataset.stripScroll = '';
  const content = make('div', 'strip-content');
  content.dataset.stripContent = '';
  scroller.appendChild(content);
  attachZoom(ctx, scroller);
  // Mounted before anything measures it: a detached box has no width.
  filmstrip.append(header, scroller);

  // Measured from the viewport, not from the strip: the gaps between cells are part
  // of the width too, so a fit has to be divided out of what the gaps leave.
  const viewport = scroller.clientWidth || filmstrip.clientWidth;
  const gaps = Math.max(0, frameCount - 1) * GAP_PX;
  const fitWidth = frameCount > 0 ? (viewport - gaps) / frameCount : CELL_PX;

  // At 1× the columns share the strip out themselves (`1fr`, no floor), so the fit
  // holds at any window width without watching for resizes. Past 1× the width is a
  // real number, floored at CELL_PX to keep the digits legible, and it overflows.
  if (isFit) {
    content.style.setProperty('--cell-w', `${Math.max(CELL_PX, fitWidth)}px`);
  } else {
    const cellWidth = Math.max(CELL_PX, fitWidth * state.trackZoom);
    content.style.setProperty('--cell-w', `${cellWidth}px`);
    content.style.width = `${Math.max(frameCount * cellWidth + gaps, 1)}px`;
  }

  const frames = make('div', 'film');
  frames.setAttribute('role', 'list');
  frames.style.gridTemplateColumns = isFit
    ? `repeat(${frameCount}, minmax(0, 1fr))`
    : `repeat(${frameCount}, minmax(var(--cell-w), 1fr))`;
  for (let index = 0; index < frameCount; index += 1) {
    const cell = make('button', 'cell');
    cell.dataset.frame = String(index);
    cell.setAttribute('role', 'listitem');
    cell.title = `frame ${index}`;
    cell.textContent = String(index);
    cell.classList.toggle('sel', index === state.frame);
    cell.classList.toggle('inrange', ctx.cut.inRange(index));
    cell.addEventListener('click', () => {
      // A frame carries its Segment with it, so the inspector follows the scrub.
      ctx.cut.scrubTo(index);
      paintPlayButton(ctx);
      ctx.cut.paintMarks();
    });
    // Arrow keys scrub from wherever the focus is, so a cut can be made without a
    // pointer (Escape hatch from the drag-only band edges).
    cell.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }
      event.preventDefault();
      const target = Math.max(
        0,
        Math.min((state.cutList?.frameCount ?? 1) - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)),
      );
      ctx.cut.scrubTo(target);
      ctx.regions.filmstrip.querySelector<HTMLElement>(`[data-frame="${target}"]`)?.focus();
    });
    frames.appendChild(cell);
  }

  content.append(frames, cutTrack(ctx));
}

/**
 * Ctrl + wheel to zoom the time axis, anchored on the frame under the pointer.
 *
 * The anchor is the whole point: a plain zoom would grow the axis about its left
 * edge and slide whatever you were aiming at off screen. Reading the fraction under
 * the cursor first, then restoring it after the rebuild, keeps that frame still.
 */
function attachZoom(ctx: FilmstripPort, scroller: HTMLElement): void {
  scroller.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      const track = ctx.regions.filmstrip.querySelector<HTMLElement>('[data-pick]');
      if (!track) {
        return;
      }
      event.preventDefault();
      const from = ctx.state.trackZoom;
      const to = clampZoom(from * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
      if (to === from) {
        return;
      }
      const rect = track.getBoundingClientRect();
      // Where the pointer is across the axis now, in frames, and how far into the
      // viewport it sits — both are restored once the wider axis exists.
      const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
      const offsetInViewport = event.clientX - scroller.getBoundingClientRect().left;

      ctx.state.trackZoom = to;
      ctx.renderFilmstrip();
      // The re-render replaces the scroller, so re-find it before restoring.
      const live = ctx.regions.filmstrip.querySelector<HTMLElement>('[data-pick]');
      const liveScroller = ctx.regions.filmstrip.querySelector<HTMLElement>('[data-strip-scroll]');
      const width = live?.getBoundingClientRect().width ?? 0;
      if (liveScroller) {
        liveScroller.scrollLeft = Math.max(0, fraction * width - offsetInViewport);
      }
    },
    { passive: false },
  );
}

/** Keep the zoom between fitting the strip and {@link ZOOM_MAX}×. */
function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(1, zoom));
}

/** `frame N / M · K segment(s)` */
function frameCounter(frame: number, frameCount: number, segments: number): string {
  return `frame ${frame} / ${frameCount} · ${segments} segment(s)`;
}

/**
 * The play/pause toggle for the loaded Recording.
 *
 * Playback is offered only while a Recording is loaded and has frames; anywhere
 * else the button is a disabled reminder of what the strip is for.
 */
function playButton(ctx: FilmstripPort): HTMLElement {
  const playable = (ctx.state.cutList?.frameCount ?? 0) > 0;
  const button = make(
    'button',
    'btn small ghost dock-btn filmstrip-play',
    ctx.state.playing ? '⏸ Pause' : '▶ Play',
  ) as HTMLButtonElement;
  button.type = 'button';
  button.dataset.recordingPlay = '';
  button.setAttribute('aria-pressed', String(ctx.state.playing));
  button.title = ctx.state.selection
    ? 'Play the marked frames'
    : (ctx.state.cutList?.cuts.length ?? 0) > 0
      ? 'Play the Segment at the playhead'
      : 'Play the Recording from the selected frame';
  button.disabled = !playable;
  button.addEventListener('click', () => ctx.cut.togglePlayback());
  return button;
}

/** Sync the toggle with `state.playing` without re-rendering the strip. */
export function paintPlayButton(ctx: FilmstripPort): void {
  const button = ctx.regions.filmstrip.querySelector<HTMLButtonElement>('[data-recording-play]');
  if (!button) {
    return;
  }
  button.textContent = ctx.state.playing ? '⏸ Pause' : '▶ Play';
  button.setAttribute('aria-pressed', String(ctx.state.playing));
}

/**
 * The one track: it is the cut list, and it is where a range is marked.
 *
 * There is a single rail rather than a pick rail stacked on a cut rail, because
 * the two mean the same thing — a frame range — and showing both at once left the
 * reader to work out which one a drag would touch. Pressing empty track marks a
 * new range; a band is pressed to edit it instead, so the two never compete.
 */
function cutTrack(ctx: FilmstripPort): HTMLElement {
  const track = make('div', 'timeline pick');
  track.dataset.timeline = '';
  track.dataset.pick = '';
  const frameCount = ctx.state.cutList?.frameCount ?? 0;
  const selection = ctx.state.selection;

  if (selection) {
    const band = make('span', 'pick-band sel');
    band.dataset.pickBand = '';
    band.style.left = `${(selection.startFrame / frameCount) * 100}%`;
    band.style.width = `${((selection.endFrame - selection.startFrame) / frameCount) * 100}%`;
    track.appendChild(band);
  }

  for (const cut of ctx.state.cutList?.cuts ?? []) {
    track.appendChild(cutRange(ctx, cut));
  }

  track.addEventListener('pointerdown', (event) => {
    if (frameCount === 0 || event.button !== 0) {
      return;
    }
    // A band (and its handles) belongs to an existing Segment; empty track marks
    // a new range.
    if ((event.target as HTMLElement).closest('[data-cut]')) {
      return;
    }
    event.preventDefault();
    ctx.cut.beginPick(track, event);
  });

  return track;
}

/**
 * One cut band, with its two drag handles when it is the one being edited.
 *
 * The band is also the Segment's pick: clicking it selects the cut for the
 * inspector and takes the playhead to its first frame. Handles only exist on the
 * selected band, so a dense Recording is not a field of grab points — press the
 * band first, then its edges.
 */
function cutRange(ctx: FilmstripPort, cut: Segment): HTMLElement {
  const frameCount = ctx.state.cutList?.frameCount ?? 1;
  const range = make('div', 'cut');
  range.dataset.cut = cut.id;
  range.dataset.cutStart = String(cut.startFrame);
  range.dataset.cutEnd = String(cut.endFrame);
  range.style.left = `${(cut.startFrame / frameCount) * 100}%`;
  range.style.width = `${((cut.endFrame - cut.startFrame) / frameCount) * 100}%`;
  range.title = `${cut.id} [${cut.startFrame}, ${cut.endFrame})`;
  const selected = cut.id === ctx.state.selectedCut;
  range.classList.toggle('sel', selected);
  range.addEventListener('click', (event) => {
    // A drag on a handle also fires a click; the handle's own pointer-up already
    // persisted the range, and re-selecting would only move the playhead away.
    if ((event.target as HTMLElement).dataset.cutHandle) {
      return;
    }
    ctx.cut.selectSegment(cut);
  });

  if (!selected) {
    return range;
  }
  for (const edge of ['start', 'end'] as const) {
    const handle = make('span', 'cut-handle');
    handle.dataset.cutHandle = edge;
    handle.style[edge === 'start' ? 'left' : 'right'] = '0';
    handle.addEventListener('pointerdown', (event) => {
      ctx.cut.startTrim(handle, edge, cut, range, event);
    });
    range.appendChild(handle);
  }
  return range;
}

/** Reflect the active frame, touching only what the frame changed. */
export function updateFrame(ctx: FilmstripPort): void {
  const { filmstrip } = ctx.regions;
  const { state } = ctx;
  filmstrip.dataset.activeFrame = String(state.frame);
  for (const cell of filmstrip.querySelectorAll<HTMLElement>('[data-frame]')) {
    cell.classList.toggle('sel', Number(cell.dataset.frame) === state.frame);
  }
  const sub = filmstrip.querySelector('[data-filmstrip-header] .muted');
  if (sub && state.cutList) {
    sub.textContent = frameCounter(
      state.frame,
      state.cutList.frameCount,
      state.cutList.cuts.length,
    );
  }
  paintPreview(ctx);
  ctx.renderContext();
  ctx.renderInspector();
}

/**
 * Move the big preview to the active frame in place.
 *
 * Scrubbing (and therefore playback) must not rebuild the stage — that would drop
 * the preview's own node, and with it any in-flight image — so the preview is
 * updated where it stands. A stage that is not showing a Recording simply has
 * nothing to paint.
 */
function paintPreview(ctx: FilmstripPort): void {
  const { state } = ctx;
  const viewer = ctx.regions.stage.querySelector<HTMLElement>('[data-recording-viewer]');
  if (!viewer || !state.recordingId) {
    return;
  }
  viewer.dataset.activeFrame = String(state.frame);

  const image = viewer.querySelector<HTMLImageElement>('[data-recording-frame]');
  if (image) {
    image.dataset.frameIndex = String(state.frame);
    image.src = ctx.api.recordingFrameUrl(state.recordingId, state.frame);
    image.alt = `${state.recordingId} frame ${state.frame}`;
  }

  const frameCount = state.cutList?.frameCount ?? 0;
  const prev = viewer.querySelector<HTMLButtonElement>('[data-frame-step="prev"]');
  if (prev) {
    prev.disabled = state.frame <= 0;
  }
  const next = viewer.querySelector<HTMLButtonElement>('[data-frame-step="next"]');
  if (next) {
    next.disabled = state.frame >= frameCount - 1;
  }
  const counter = viewer.querySelector<HTMLElement>('[data-recording-frame-counter]');
  if (counter) {
    counter.textContent = `frame ${state.frame} / ${frameCount}`;
  }
}

/** Re-export the range label so views keep one wording. */
export { rangeLabel };
