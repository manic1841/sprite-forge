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

  const controls = make('span', 'filmstrip-controls');
  if (state.selection) {
    controls.append(sub, selectionActions(ctx, state.selection), playButton(ctx));
  } else {
    controls.append(sub, pickButton(ctx), playButton(ctx));
  }
  header.append(title, controls);

  const frames = make('div', 'film');
  frames.setAttribute('role', 'list');
  for (let index = 0; index < (state.cutList?.frameCount ?? 0); index += 1) {
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
      state.selectedCut = covering ? covering.id : null;
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

  const timeline = make('div', 'timeline');
  timeline.dataset.timeline = '';
  for (const cut of state.cutList?.cuts ?? []) {
    timeline.appendChild(cutRange(ctx, cut));
  }

  filmstrip.append(header, frames, pickTrack(ctx), timeline);

  // The hint belongs beside the strip it describes, not across the screen in the
  // inspector.
  if (state.cutList) {
    filmstrip.appendChild(
      make(
        'p',
        'filmstrip-hint',
        'Drag across the track to mark a range, play it to check, then Segment. Dragging a band\'s edge re-cuts it.',
      ),
    );
  }
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
 * The track you drag a range on.
 *
 * Cutting happens here rather than through start/end inputs: the range is drawn
 * under the frames, Play confirms it, and only then is it written as a Segment.
 * A plain click marks a single frame, so a short cut needs no drag at all.
 */
function pickTrack(ctx: WorkbenchContext): HTMLElement {
  const track = make('div', 'pick');
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

  const frameAt = (clientX: number): number => {
    const rect = track.getBoundingClientRect();
    const raw = Math.floor(((clientX - rect.left) / rect.width) * frameCount);
    return Math.max(0, Math.min(frameCount - 1, raw));
  };

  track.addEventListener('pointerdown', (event) => {
    if (frameCount === 0 || event.button !== 0) {
      return;
    }
    event.preventDefault();
    stopPlayback(ctx.state);
    const anchor = frameAt(event.clientX);
    const paint = (cursor: number): void => {
      const [start, end] = anchor <= cursor ? [anchor, cursor] : [cursor, anchor];
      ctx.state.selection = { startFrame: start, endFrame: end + 1 };
      paintSelection(ctx);
    };
    paint(anchor);

    const move = (moveEvent: PointerEvent): void => paint(frameAt(moveEvent.clientX));
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // Land on the range's first frame and let the inspector show it as a cut
      // to come: the selection is confirmed by playing it, then saved.
      if (ctx.state.selection) {
        selectFrame(ctx, ctx.state.selection.startFrame);
        paintSelection(ctx);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  return track;
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

  const label = ctx.regions.filmstrip.querySelector<HTMLElement>('[data-pick-label]');
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
function selectionActions(
  ctx: WorkbenchContext,
  selection: { startFrame: number; endFrame: number },
): HTMLElement {
  const group = make('span', 'filmstrip-selection');
  const label = make('span', 'muted');
  label.dataset.pickLabel = '';
  label.textContent = rangeLabel(selection);

  const save = make('button', 'btn small', 'Segment') as HTMLButtonElement;
  save.type = 'button';
  save.dataset.pickSave = '';
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

/**
 * Mark a range from the keyboard: a one-frame selection at the playhead.
 *
 * Dragging on the pick track is the normal way, but a cut still has to be
 * reachable without a drag — this seeds the range, which is then widened by
 * dragging its band.
 */
function pickButton(ctx: WorkbenchContext): HTMLElement {
  const button = make('button', 'btn small ghost filmstrip-play', 'Mark') as HTMLButtonElement;
  button.type = 'button';
  button.dataset.pickStart = '';
  button.title = 'Mark the current frame as the start of a range';
  button.disabled = (ctx.state.cutList?.frameCount ?? 0) === 0;
  button.addEventListener('click', () => {
    stopPlayback(ctx.state);
    const frame = ctx.state.frame;
    ctx.state.selection = { startFrame: frame, endFrame: frame + 1 };
    ctx.renderFilmstrip();
    ctx.renderInspector();
  });
  return button;
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
 * One cut band with its two drag handles.
 *
 * The band is also the Segment's pick: clicking it selects the cut for the
 * inspector and takes the playhead to its first frame, so a band is both what is
 * seen and what is edited.
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
  range.classList.toggle('sel', cut.id === ctx.state.selectedCut);
  range.addEventListener('click', (event) => {
    // A drag on a handle also fires a click; the handle's own pointer-up already
    // persisted the range, and re-selecting would only move the playhead away.
    if ((event.target as HTMLElement).dataset.cutHandle) {
      return;
    }
    selectSegment(ctx, cut);
  });

  for (const edge of ['start', 'end'] as const) {
    const handle = make('span', 'cut-handle');
    handle.dataset.cutHandle = edge;
    handle.style[edge === 'start' ? 'left' : 'right'] = '0';
    attachDrag(ctx, handle, edge, cut, range);
    range.appendChild(handle);
  }
  return range;
}

/** Drag a cut edge: move the visuals live, persist the range on release. */
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
    const move = (moveEvent: PointerEvent): void => {
      paint(clampRange(edge, frameAt(moveEvent.clientX), cut, frameCount));
    };
    const up = (upEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const next = clampRange(edge, frameAt(upEvent.clientX), cut, frameCount);
      void ctx.run('Re-cut segment', () =>
        persistRange(ctx, cut.id, next.startFrame, next.endFrame),
      );
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
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
