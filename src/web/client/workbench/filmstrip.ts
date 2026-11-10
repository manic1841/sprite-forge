/**
 * The filmstrip: the loaded Recording as a frame-accurate scrubber.
 *
 * The frame index is the unit. Cut ranges are drawn as draggable bands over the
 * same track; a drag only repositions visuals until pointer-up, then persists the
 * clamped range and re-renders. The clamping itself is a pure function in
 * `../timeline.ts`.
 */

import { clampRange } from '../timeline.js';
import type { WorkbenchContext } from './context.js';
import { make } from './dom.js';
import type { Segment } from '../types.js';

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
  header.append(title, sub);

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
    cell.addEventListener('click', () => selectFrame(ctx, index));
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

  filmstrip.append(header, frames, timeline);
}

/** `frame N / M · K segment(s)` */
function frameCounter(frame: number, frameCount: number, segments: number): string {
  return `frame ${frame} / ${frameCount} · ${segments} segment(s)`;
}

function inRange(ctx: WorkbenchContext, frame: number): boolean {
  return (ctx.state.cutList?.cuts ?? []).some(
    (cut) => frame >= cut.startFrame && frame < cut.endFrame,
  );
}

/** One cut band with its two drag handles. */
function cutRange(ctx: WorkbenchContext, cut: Segment): HTMLElement {
  const frameCount = ctx.state.cutList?.frameCount ?? 1;
  const range = make('div', 'cut');
  range.dataset.cut = cut.id;
  range.dataset.cutStart = String(cut.startFrame);
  range.dataset.cutEnd = String(cut.endFrame);
  range.style.left = `${(cut.startFrame / frameCount) * 100}%`;
  range.style.width = `${((cut.endFrame - cut.startFrame) / frameCount) * 100}%`;
  range.title = `${cut.id} [${cut.startFrame}, ${cut.endFrame})`;

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
  ctx.renderContext();
  ctx.renderInspector();
}
