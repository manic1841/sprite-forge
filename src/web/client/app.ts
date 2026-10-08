/**
 * The browser workbench: a persistent shell of four regions.
 *
 *   rail (Library) | [ modes header, stage, filmstrip ] | inspector (contextual)
 *
 * The **mode switch swaps only the stage**; the rail, inspector and filmstrip
 * stay mounted and unchanged. Nothing here holds business logic — loading a
 * Recording and editing a cut both go through {@link WorkbenchApi}, which the
 * Node server turns into core calls. Stages for Clip editor / Alignment / Export
 * are placeholders (#26 / #28 / #30) but the swap contract is real.
 */

import type { WorkbenchApi } from './api.js';
import type { CutList, Segment, StoreScan } from './types.js';

/** The three stage modes. The rail, inspector and filmstrip do not change with them. */
export const WORKBENCH_MODES = ['clip', 'align', 'export'] as const;
export type WorkbenchMode = (typeof WORKBENCH_MODES)[number];

const MODE_LABEL: Record<WorkbenchMode, string> = {
  clip: 'Clip editor',
  align: 'Alignment',
  export: 'Export',
};

/** Options for {@link mountWorkbench}. */
export interface WorkbenchOptions {
  /** The server boundary. A stub can stand in for it in tests. */
  api: WorkbenchApi;
}

/** The mounted workbench, exposing enough state for tests and embedding. */
export interface WorkbenchHandle {
  /** The shell root (`data-mode` reflects the active stage). */
  readonly root: HTMLElement;
  /** Resolves once the initial Library scan has rendered. */
  readonly ready: Promise<void>;
  /** The active stage mode. */
  readonly mode: WorkbenchMode;
  /** The id of the loaded Recording, or `null`. */
  readonly activeRecording: string | null;
  /** The active frame index (the scrub unit). */
  readonly activeFrame: number;
  /** Switch mode; swaps the stage only. */
  setMode(mode: WorkbenchMode): void;
  /** Load a Recording: read its cut list and show it in the filmstrip. */
  loadRecording(recordingId: string): Promise<void>;
  /** Await the most recent {@link loadRecording} kicked off by a click. */
  settled(): Promise<void>;
}

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

/** Mount the workbench into `container`, returning a handle to it. */
export function mountWorkbench(
  container: HTMLElement,
  options: WorkbenchOptions,
): WorkbenchHandle {
  const { api } = options;
  container.innerHTML = '';

  const state: {
    mode: WorkbenchMode;
    scan: StoreScan | null;
    recordingId: string | null;
    frame: number;
    cutList: CutList | null;
  } = { mode: 'clip', scan: null, recordingId: null, frame: 0, cutList: null };

  // --- shell ----------------------------------------------------------------
  const root = make('div', 'workbench');
  root.dataset.mode = state.mode;

  const rail = make('aside', 'rail');
  rail.dataset.region = 'rail';

  const centre = make('div', 'centre');

  const modes = make('header', 'modes');
  modes.dataset.region = 'modes';
  const modeButtons = WORKBENCH_MODES.map((mode) => {
    const button = make('button', 'btn');
    button.dataset.mode = mode;
    button.textContent = MODE_LABEL[mode];
    button.addEventListener('click', () => setMode(mode));
    modes.appendChild(button);
    return button;
  });
  const contextPill = make('span', 'pill');
  contextPill.dataset.region = 'context';
  modes.appendChild(contextPill);

  const stage = make('main', 'stage');
  stage.dataset.region = 'stage';

  const filmstrip = make('footer', 'filmstrip');
  filmstrip.dataset.region = 'filmstrip';

  const inspector = make('aside', 'inspector');
  inspector.dataset.region = 'inspector';

  centre.append(modes, stage, filmstrip);
  root.append(rail, centre, inspector);
  container.appendChild(root);

  // --- library --------------------------------------------------------------
  function renderLibrary(): void {
    rail.innerHTML = '';
    rail.appendChild(heading('Library'));

    rail.appendChild(subheading('Recordings'));
    const recordings = make('div', 'list');
    recordings.dataset.librarySection = 'recordings';
    for (const recording of state.scan?.recordings ?? []) {
      const item = make('button', 'asset');
      item.dataset.recording = recording.id;
      item.classList.toggle('sel', recording.id === state.recordingId);
      item.append(
        make('span', 'asset-name', recording.id),
        make('span', 'asset-sub', recording.dir),
      );
      item.addEventListener('click', () => {
        lastLoad = loadRecording(recording.id);
      });
      recordings.appendChild(item);
    }
    rail.appendChild(recordings);

    rail.appendChild(subheading('Committed assets'));
    const assets = make('div', 'list');
    assets.dataset.librarySection = 'assets';
    for (const character of state.scan?.characters ?? []) {
      for (const asset of character.assets) {
        const item = make('button', 'asset');
        item.dataset.asset = asset.id;
        item.dataset.assetKind = asset.kind;
        item.dataset.character = character.id;
        item.append(
          make('span', 'asset-name', asset.id),
          make('span', 'tag', asset.kind),
        );
        assets.appendChild(item);
      }
    }
    rail.appendChild(assets);
  }

  // --- stage ----------------------------------------------------------------
  function renderStage(): void {
    // Contract: only the stage's contents change here. The rail, inspector and
    // filmstrip nodes are never touched by a mode switch.
    stage.innerHTML = '';
    stage.appendChild(stageView(state.mode));
  }

  function stageView(mode: WorkbenchMode): HTMLElement {
    if (mode === 'clip') {
      const view = make('div', 'stage-view');
      view.dataset.stageView = 'clip-editor';
      const scrub = make('div', 'scrub');
      const prev = make('button', 'btn ghost', '◀ frame');
      const next = make('button', 'btn ghost', 'frame ▶');
      prev.addEventListener('click', () => stepFrame(-1));
      next.addEventListener('click', () => stepFrame(1));
      scrub.append(prev, next);
      const note = make('p', 'muted', 'Clip editor — the frame, segmentation scrub and Repair brush arrive in #26.');
      view.append(scrub, note);
      return view;
    }
    if (mode === 'align') {
      const view = make('div', 'stage-view');
      view.dataset.stageView = 'alignment';
      view.appendChild(
        make('p', 'muted', 'Alignment — Clips ghosted on the shared Canvas against the Anchor (#28).'),
      );
      return view;
    }
    const view = make('div', 'stage-view');
    view.dataset.stageView = 'export';
    view.appendChild(make('p', 'muted', 'Export — Situation bindings and the live Manifest (#30).'));
    return view;
  }

  // --- filmstrip ------------------------------------------------------------
  function renderFilmstrip(): void {
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
      ? `frame ${state.frame} / ${state.cutList.frameCount} · ${state.cutList.cuts.length} segment(s)`
      : 'load a Recording to scrub its frames';
    header.append(title, sub);

    const frames = make('div', 'film');
    frames.setAttribute('role', 'list');
    const frameCount = state.cutList?.frameCount ?? 0;
    for (let index = 0; index < frameCount; index += 1) {
      const cell = make('button', 'cell');
      cell.dataset.frame = String(index);
      cell.setAttribute('role', 'listitem');
      cell.title = `frame ${index}`;
      cell.textContent = String(index);
      cell.classList.toggle('sel', index === state.frame);
      cell.classList.toggle('inrange', inRange(index));
      cell.addEventListener('click', () => selectFrame(index));
      frames.appendChild(cell);
    }

    const timeline = make('div', 'timeline');
    timeline.dataset.timeline = '';
    if (state.cutList) {
      for (const cut of state.cutList.cuts) {
        timeline.appendChild(cutRange(cut));
      }
    }

    filmstrip.append(header, frames, timeline);
  }

  function inRange(frame: number): boolean {
    return (state.cutList?.cuts ?? []).some(
      (cut) => frame >= cut.startFrame && frame < cut.endFrame,
    );
  }

  function cutRange(cut: Segment): HTMLElement {
    const frameCount = state.cutList?.frameCount ?? 1;
    const range = make('div', 'cut');
    range.dataset.cut = cut.id;
    range.dataset.cutStart = String(cut.startFrame);
    range.dataset.cutEnd = String(cut.endFrame);
    const left = (cut.startFrame / frameCount) * 100;
    const width = ((cut.endFrame - cut.startFrame) / frameCount) * 100;
    range.style.left = `${left}%`;
    range.style.width = `${width}%`;
    range.title = `${cut.id} [${cut.startFrame}, ${cut.endFrame})`;

    for (const edge of ['start', 'end'] as const) {
      const handle = make('span', 'cut-handle');
      handle.dataset.cutHandle = edge;
      handle.style[edge === 'start' ? 'left' : 'right'] = '0';
      attachDrag(handle, edge, cut, range);
      range.appendChild(handle);
    }
    return range;
  }

  /** Drag a cut edge: update the visuals live, persist the range on release. */
  function attachDrag(
    handle: HTMLElement,
    edge: 'start' | 'end',
    cut: Segment,
    range: HTMLElement,
  ): void {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const track = handle.parentElement!.parentElement!;
      const rect = track.getBoundingClientRect();
      const frameCount = state.cutList?.frameCount ?? 1;

      const frameAt = (clientX: number): number =>
        Math.round(((clientX - rect.left) / rect.width) * frameCount);

      const move = (moveEvent: PointerEvent): void => {
        const next = clampRange(edge, frameAt(moveEvent.clientX), cut, frameCount);
        const left = (next.startFrame / frameCount) * 100;
        const width = ((next.endFrame - next.startFrame) / frameCount) * 100;
        range.style.left = `${left}%`;
        range.style.width = `${width}%`;
      };
      const up = (upEvent: PointerEvent): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const next = clampRange(edge, frameAt(upEvent.clientX), cut, frameCount);
        void persistRange(cut.id, next.startFrame, next.endFrame);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  async function persistRange(cutId: string, startFrame: number, endFrame: number): Promise<void> {
    if (!state.recordingId) {
      return;
    }
    state.cutList = await api.setSegmentRange(state.recordingId, cutId, startFrame, endFrame);
    renderFilmstrip();
  }

  function selectFrame(index: number): void {
    state.frame = index;
    updateFrame();
  }

  function stepFrame(delta: number): void {
    const frameCount = state.cutList?.frameCount ?? 0;
    if (frameCount === 0) {
      return;
    }
    state.frame = Math.max(0, Math.min(frameCount - 1, state.frame + delta));
    updateFrame();
  }

  /** Reflect the active frame without rebuilding the shell or the rail. */
  function updateFrame(): void {
    filmstrip.dataset.activeFrame = String(state.frame);
    for (const cell of filmstrip.querySelectorAll<HTMLElement>('[data-frame]')) {
      cell.classList.toggle('sel', Number(cell.dataset.frame) === state.frame);
    }
    const sub = filmstrip.querySelector('[data-filmstrip-header] .muted');
    if (sub && state.cutList) {
      sub.textContent = `frame ${state.frame} / ${state.cutList.frameCount} · ${state.cutList.cuts.length} segment(s)`;
    }
    renderContext();
    renderInspector();
  }

  // --- inspector & context --------------------------------------------------
  function renderContext(): void {
    if (!state.recordingId) {
      contextPill.textContent = 'no Recording loaded';
      return;
    }
    contextPill.textContent = `${state.recordingId} · frame ${state.frame}`;
  }

  function renderInspector(): void {
    inspector.innerHTML = '';
    inspector.appendChild(heading('Inspector'));
    if (!state.recordingId || !state.cutList) {
      inspector.appendChild(make('p', 'muted', 'Load a Recording to inspect it.'));
      return;
    }
    const list = make('dl', 'kv');
    addRow(list, 'recording', state.recordingId);
    addRow(list, 'frame', String(state.frame));
    addRow(list, 'frames', String(state.cutList.frameCount));
    addRow(list, 'segments', String(state.cutList.cuts.length));
    inspector.appendChild(list);
  }

  // --- wiring ---------------------------------------------------------------
  function setMode(mode: WorkbenchMode): void {
    state.mode = mode;
    root.dataset.mode = mode;
    for (const button of modeButtons) {
      button.classList.toggle('on', button.dataset.mode === mode);
    }
    renderStage();
  }

  async function loadRecording(recordingId: string): Promise<void> {
    state.recordingId = recordingId;
    state.frame = 0;
    state.cutList = await api.readCutList(recordingId);
    renderLibrary();
    renderFilmstrip();
    renderContext();
    renderInspector();
  }

  // --- initial render -------------------------------------------------------
  setMode('clip');
  renderLibrary();
  renderFilmstrip();
  renderContext();
  renderInspector();

  let lastLoad: Promise<void> = Promise.resolve();
  const ready = (async () => {
    state.scan = await api.scan();
    renderLibrary();
  })();

  return {
    root,
    ready,
    get mode() {
      return state.mode;
    },
    get activeRecording() {
      return state.recordingId;
    },
    get activeFrame() {
      return state.frame;
    },
    setMode,
    loadRecording,
    settled: () => lastLoad,
  };
}

// --- tiny DOM helpers --------------------------------------------------------

function make(tag: string, className?: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

function heading(text: string): HTMLElement {
  return make('h2', 'ttl', text);
}

function subheading(text: string): HTMLElement {
  const el = make('h3', 'ttl sub');
  el.textContent = text;
  return el;
}

function addRow(list: HTMLElement, key: string, value: string): void {
  const k = make('dt', 'k', key);
  const v = make('dd', 'v', value);
  list.append(k, v);
}
