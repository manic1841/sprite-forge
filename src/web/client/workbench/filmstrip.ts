/**
 * The filmstrip: the loaded Recording as a frame-accurate scrubber.
 *
 * The frame index is the unit. Cut ranges are drawn as draggable bands over the
 * same track; a drag only repositions visuals until pointer-up, then persists the
 * clamped range and re-renders. The clamping itself is a pure function in
 * `../timeline.ts`.
 *
 * Playback previews the Segment at the playhead — the frames its drag handles
 * span — and steps the Recording's own `delaysMs`, so what is previewed is that
 * cut at the capture's real timing. It is a *pause*-style toggle: stopping leaves
 * the frame where it is.
 */

import { clampRange } from '../timeline.js';
import type { WorkbenchContext } from './context.js';
import { make } from './dom.js';
import { saveSelectionAsSegment, paintSegmentMarks, selectSegment } from './stageCut.js';
import type { WorkbenchState } from './state.js';
import type { Segment } from '../types.js';

/** Fallback delay for a Recording whose source reports none. */
const DEFAULT_DELAY_MS = 100;

/** The pending playback tick, if playing. */
let playTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The half-open frame range playback is confined to for the current run.
 *
 * Play previews the Segment the playhead sits in — the range its drag handles
 * span — and stops at its end rather than running on into unrelated footage.
 * It is fixed when playback starts so a re-cut mid-play cannot move the finish
 * line. Without a covering Segment the whole Recording is the range, which keeps
 * Play useful on an uncut or freshly imported capture.
 */
let playRange: { startFrame: number; endFrame: number } | null = null;

/** The narrowest a frame cell is drawn, in px, before zoom starts scrolling. */
const CELL_PX = 18;
/** The space held between two cells; also part of the strip's width budget. */
const GAP_PX = 2;
/** How much one Ctrl + wheel notch multiplies the time axis. */
const ZOOM_STEP = 1.3;
const ZOOM_MAX = 8;

/** Render the whole strip from the loaded cut list. */
export function renderFilmstrip(ctx: WorkbenchContext): void {
  const { filmstrip } = ctx.regions;
  const { state } = ctx;
  filmstrip.innerHTML = '';
  filmstrip.dataset.activeFrame = String(state.frame);

  const header = make('div', 'filmstrip-header');
  header.dataset.filmstripHeader = '';
  const title = make('span', 'ttl');
  title.textContent = state.recordingId
    ? `Recording — ${state.recordingId}`
    : 'Recording — none loaded';
  const sub = make('span', 'muted');
  sub.textContent = state.cutList
    ? `${frameCounter(state.frame, state.cutList.frameCount, state.cutList.cuts.length)}`
    : 'load a Recording to scrub its frames';

  // The strip carries its own action area: the counter, the verbs a marked range
  // offers, and Play — which is what checks the range before it is kept.
  const controls = make('span', 'filmstrip-controls');
  controls.dataset.filmstripControls = '';
  controls.append(sub);
  if (state.selection) {
    controls.appendChild(selectionActions(ctx));
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
    cell.classList.toggle('inrange', inRange(ctx, index));
    cell.addEventListener('click', () => {
      // Picking a frame is a scrub, so it takes over from playback.
      stopPlayback(state);
      // A frame carries its Segment with it, so the inspector follows the scrub.
      // Set before the scrub: the frame update is what re-renders the inspector.
      const covering = segmentAt(state, index);
      // Landing in a Segment is an edit of it, and editing replaces marking.
      state.selectedCut = covering ? covering.id : state.selectedCut;
      if (covering) {
        state.selection = null;
      }
      selectFrame(ctx, index);
      paintPlayButton(ctx);
      paintSegmentMarks(ctx);
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
      selectFrame(ctx, target);
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
function attachZoom(ctx: WorkbenchContext, scroller: HTMLElement): void {
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
function playButton(ctx: WorkbenchContext): HTMLElement {
  const playable = (ctx.state.cutList?.frameCount ?? 0) > 0;
  const button = make(
    'button',
    'btn small ghost filmstrip-play',
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
  button.addEventListener('click', () => {
    if (ctx.state.playing) {
      stopPlayback(ctx.state);
    } else {
      play(ctx);
    }
    paintPlayButton(ctx);
  });
  return button;
}

/** Sync the toggle with `state.playing` without re-rendering the strip. */
function paintPlayButton(ctx: WorkbenchContext): void {
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
function cutTrack(ctx: WorkbenchContext): HTMLElement {
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
    startPick(ctx, track, event);
  });

  return track;
}

/** Drag out a range from the pressed frame, either direction. */
function startPick(ctx: WorkbenchContext, track: HTMLElement, down: PointerEvent): void {
  const frameCount = ctx.state.cutList?.frameCount ?? 0;
  stopPlayback(ctx.state);
  // Marking replaces editing: leaving a Segment selected next to a fresh range is
  // what made Play pick the wrong thing. The strip is rebuilt so the dropped
  // Segment's handles go with it; the gesture then runs against the new track.
  const restore = ctx.state.selection;
  ctx.state.selectedCut = null;
  paintSegmentMarks(ctx);
  ctx.renderFilmstrip();

  const frameAt = (clientX: number): number => {
    // Re-read the track: the rebuild above replaced the node the press landed on.
    const live = ctx.regions.filmstrip.querySelector<HTMLElement>('[data-pick]') ?? track;
    const rect = live.getBoundingClientRect();
    const raw = Math.floor(((clientX - rect.left) / rect.width) * frameCount);
    return Math.max(0, Math.min(frameCount - 1, raw));
  };

  const anchor = frameAt(down.clientX);
  const paint = (cursor: number): void => {
    const [start, end] = anchor <= cursor ? [anchor, cursor] : [cursor, anchor];
    ctx.state.selection = { startFrame: start, endFrame: end + 1 };
    paintSelection(ctx);
  };
  paint(anchor);

  const finish = (persist: boolean): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key);
    if (!persist) {
      ctx.state.selection = restore;
      ctx.renderFilmstrip();
      ctx.renderInspector();
      return;
    }
    // Land on the range's first frame and let the inspector show it as a cut to
    // come: the selection is confirmed by playing it, then saved.
    if (ctx.state.selection) {
      selectFrame(ctx, ctx.state.selection.startFrame);
      paintSelection(ctx);
    }
  };
  const move = (moveEvent: PointerEvent): void => paint(frameAt(moveEvent.clientX));
  const up = (): void => finish(true);
  const cancel = (): void => finish(false);
  const key = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key);
}

/** Repaint the pick band in place, without rebuilding the strip mid-drag. */
function paintSelection(ctx: WorkbenchContext): void {
  const track = ctx.regions.filmstrip.querySelector<HTMLElement>('[data-pick]');
  const selection = ctx.state.selection;
  if (!track || !selection) {
    return;
  }
  const frameCount = ctx.state.cutList?.frameCount ?? 1;
  let band = track.querySelector<HTMLElement>('[data-pick-band]');
  if (!band) {
    band = make('span', 'pick-band sel');
    band.dataset.pickBand = '';
    track.appendChild(band);
  }
  band.style.left = `${(selection.startFrame / frameCount) * 100}%`;
  band.style.width = `${((selection.endFrame - selection.startFrame) / frameCount) * 100}%`;

  // The verbs are only in the header when a range existed at render time; a drag
  // that starts from nothing brings them in itself rather than re-rendering
  // mid-gesture.
  const controls = ctx.regions.filmstrip.querySelector<HTMLElement>('[data-filmstrip-controls]');
  if (!controls) {
    return;
  }
  let group = controls.querySelector<HTMLElement>('[data-pick-actions]');
  if (!group) {
    group = selectionActions(ctx);
    controls.insertBefore(group, controls.querySelector('[data-recording-play]'));
  }
  const label = group.querySelector<HTMLElement>('[data-pick-label]');
  if (label) {
    label.textContent = rangeLabel(selection);
  }
}

/** `frames 1–3` — what the selection covers, in inclusive human terms. */
function rangeLabel(selection: { startFrame: number; endFrame: number }): string {
  const last = selection.endFrame - 1;
  return selection.startFrame === last
    ? `frame ${last}`
    : `frames ${selection.startFrame}–${last}`;
}

/**
 * The actions a marked range offers: confirm it with Play, then keep it.
 *
 * This is the short-lived counterpart of the inspector's Segment editor — it only
 * exists while a range is picked, because a Segment is the *output* of a range.
 */
export function selectionActions(ctx: WorkbenchContext): HTMLElement {
  const group = make('span', 'filmstrip-selection');
  group.dataset.pickActions = '';
  const label = make('span', 'muted');
  label.dataset.pickLabel = '';
  label.textContent = ctx.state.selection ? rangeLabel(ctx.state.selection) : '';

  const save = make('button', 'btn small', '✂') as HTMLButtonElement;
  save.type = 'button';
  save.dataset.pickSave = '';
  save.setAttribute('aria-label', 'Save the marked frames as a Segment');
  save.title = 'Save the marked frames as a Segment';
  save.addEventListener('click', () => {
    stopPlayback(ctx.state);
    void ctx.run('Add segment', () => saveSelectionAsSegment(ctx));
  });

  const cancel = make('button', 'btn small ghost', '✕') as HTMLButtonElement;
  cancel.type = 'button';
  cancel.dataset.pickCancel = '';
  cancel.setAttribute('aria-label', 'Clear the marked frames');
  cancel.title = 'Clear the marked frames';
  cancel.addEventListener('click', () => {
    stopPlayback(ctx.state);
    ctx.state.selection = null;
    ctx.renderFilmstrip();
    ctx.renderInspector();
  });

  group.append(label, save, cancel);
  return group;
}

/** The Segment covering `frame`, if any. */
function segmentAt(state: WorkbenchState, frame: number): Segment | null {
  return (
    state.cutList?.cuts.find((cut) => frame >= cut.startFrame && frame < cut.endFrame) ?? null
  );
}

/**
 * The half-open range playback should preview.
 *
 * A marked range comes first: it is a cut being previewed before it exists, which
 * is the whole point of marking one. Otherwise the playhead *is* the selection,
 * so the range is the Segment it sits in; outside every Segment (frame 0 of a
 * freshly cut capture is the common case) it is the next Segment after it, else
 * the last one — Play previews a cut, never the surrounding footage. Only an
 * uncut Recording has no Segment, and then it plays whole.
 */
function playbackRange(state: WorkbenchState): { startFrame: number; endFrame: number } | null {
  const frameCount = state.cutList?.frameCount ?? 0;
  if (frameCount === 0) {
    return null;
  }
  if (state.selection) {
    return state.selection;
  }
  const cuts = state.cutList?.cuts ?? [];
  const segment =
    segmentAt(state, state.frame) ??
    cuts.find((cut) => cut.endFrame > state.frame) ??
    cuts[cuts.length - 1];
  return segment
    ? { startFrame: segment.startFrame, endFrame: segment.endFrame }
    : { startFrame: 0, endFrame: frameCount };
}

/**
 * Play the range resolved for the playhead.
 *
 * A playhead outside that range rewinds to its first frame, so Play always
 * previews the same whole cut; at its end it replays from the start.
 */
function play(ctx: WorkbenchContext): void {
  const range = playbackRange(ctx.state);
  if (!range) {
    return;
  }
  stopPlayback(ctx.state);
  playRange = range;

  if (ctx.state.frame >= playRange.endFrame - 1 || ctx.state.frame < playRange.startFrame) {
    selectFrame(ctx, playRange.startFrame);
  }
  ctx.state.playing = true;
  scheduleTick(ctx);
}

/** Queue the next frame after *its own* delay, so timing is the capture's. */
function scheduleTick(ctx: WorkbenchContext): void {
  const delay = ctx.state.recordingDelaysMs[ctx.state.frame] ?? DEFAULT_DELAY_MS;
  playTimer = setTimeout(() => tick(ctx), delay);
}

function tick(ctx: WorkbenchContext): void {
  playTimer = null;
  // Playback only means something while the Recording is still the open target.
  if (ctx.state.target.kind !== 'recording' || !playRange) {
    stopPlayback(ctx.state);
    paintPlayButton(ctx);
    return;
  }
  if (ctx.state.frame >= playRange.endFrame - 1) {
    stopPlayback(ctx.state);
    paintPlayButton(ctx);
    return;
  }
  selectFrame(ctx, ctx.state.frame + 1);
  scheduleTick(ctx);
}

/** Stop advancing and leave the frame where it is. Safe without a render. */
export function stopPlayback(state: WorkbenchState): void {
  if (playTimer !== null) {
    clearTimeout(playTimer);
    playTimer = null;
  }
  playRange = null;
  state.playing = false;
}

function inRange(ctx: WorkbenchContext, frame: number): boolean {
  return (ctx.state.cutList?.cuts ?? []).some(
    (cut) => frame >= cut.startFrame && frame < cut.endFrame,
  );
}

/**
 * One cut band, with its two drag handles when it is the one being edited.
 *
 * The band is also the Segment's pick: clicking it selects the cut for the
 * inspector and takes the playhead to its first frame. Handles only exist on the
 * selected band, so a dense Recording is not a field of grab points — press the
 * band first, then its edges.
 */
function cutRange(ctx: WorkbenchContext, cut: Segment): HTMLElement {
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
    selectSegment(ctx, cut);
  });

  if (!selected) {
    return range;
  }
  for (const edge of ['start', 'end'] as const) {
    const handle = make('span', 'cut-handle');
    handle.dataset.cutHandle = edge;
    handle.style[edge === 'start' ? 'left' : 'right'] = '0';
    attachDrag(ctx, handle, edge, cut, range);
    range.appendChild(handle);
  }
  return range;
}

/**
 * Drag a cut edge: move the visuals live, persist the range on release.
 *
 * Releasing **is** the save — trimming is a direct manipulation of a stored range,
 * so it needs no confirm step (only a new Segment does, because it needs a name).
 * Escape or a cancelled pointer puts the edge back untouched.
 */
function attachDrag(
  ctx: WorkbenchContext,
  handle: HTMLElement,
  edge: 'start' | 'end',
  cut: Segment,
  range: HTMLElement,
): void {
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const track = handle.parentElement!.parentElement!;
    const rect = track.getBoundingClientRect();
    const frameCount = ctx.state.cutList?.frameCount ?? 1;
    const frameAt = (clientX: number): number =>
      Math.round(((clientX - rect.left) / rect.width) * frameCount);

    const paint = (next: { startFrame: number; endFrame: number }): void => {
      range.style.left = `${(next.startFrame / frameCount) * 100}%`;
      range.style.width = `${((next.endFrame - next.startFrame) / frameCount) * 100}%`;
    };
    const settle = (clientX: number): { startFrame: number; endFrame: number } =>
      clampRange(edge, frameAt(clientX), cut, frameCount);

    const finish = (persist: boolean, clientX = 0): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      if (!persist) {
        paint(cut);
        return;
      }
      const next = settle(clientX);
      void ctx.run('Re-cut segment', () =>
        persistRange(ctx, cut.id, next.startFrame, next.endFrame),
      );
    };

    const move = (moveEvent: PointerEvent): void => paint(settle(moveEvent.clientX));
    const up = (upEvent: PointerEvent): void => finish(true, upEvent.clientX);
    const cancel = (): void => finish(false);
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
  });
}

async function persistRange(
  ctx: WorkbenchContext,
  cutId: string,
  startFrame: number,
  endFrame: number,
): Promise<void> {
  const { state, api } = ctx;
  if (!state.recordingId) {
    return;
  }
  state.cutList = await api.setSegmentRange(state.recordingId, cutId, startFrame, endFrame);
  ctx.renderFilmstrip();
  ctx.renderInspector();
}

/** Move the scrub position without rebuilding the strip. */
function selectFrame(ctx: WorkbenchContext, index: number): void {
  ctx.state.frame = index;
  updateFrame(ctx);
}

/** Reflect the active frame, touching only what the frame changed. */
export function updateFrame(ctx: WorkbenchContext): void {
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
function paintPreview(ctx: WorkbenchContext): void {
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
