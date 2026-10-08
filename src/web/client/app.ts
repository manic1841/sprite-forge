/**
 * The browser workbench: a persistent shell of four regions.
 *
 *   rail (Library) | [ modes header, stage, filmstrip ] | inspector (contextual)
 *
 * The **mode switch swaps only the stage**; the rail, inspector and filmstrip
 * regions stay mounted and keep their node identity. The inspector's *content*
 * is contextual to the active mode (docs/architecture.md, "Inspector (right,
 * contextual)"): entering the Clip editor shows the Draft's per-frame info and
 * the Repair slot #27 fills in; Alignment and Export get their own sections
 * later. Nothing here holds business logic — every read and write goes through
 * {@link WorkbenchApi}, which the Node server turns into core calls.
 */

import type { WorkbenchApi } from './api.js';
import type {
  ClipDraft,
  CutList,
  RepairOperationInput,
  RepairState,
  RepairTool,
  RepairWarning,
  Segment,
  StoreScan,
} from './types.js';

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
  /** The active Recording frame index (the scrub unit), or `null` item. */
  readonly activeFrame: number;
  /** The active Draft as `{characterId, draftId}`, or `null`. */
  readonly activeDraft: { characterId: string; draftId: string } | null;
  /** The active Draft frame index (the Clip-editor unit); `0` when none. */
  readonly activeDraftFrame: number;
  /** The active Draft's Repair state (operations + warnings), or `null`. */
  readonly repair: RepairState | null;
  /** Switch mode; swaps the stage and re-renders the contextual inspector. */
  setMode(mode: WorkbenchMode): void;
  /** Load a Recording: read its cut list and show it in the filmstrip. */
  loadRecording(recordingId: string): Promise<void>;
  /** Load a Draft: read its descriptor and show its frames in the Clip editor. */
  loadDraft(characterId: string, draftId: string): Promise<void>;
  /** Await the most recent {@link loadRecording}/{@link loadDraft} kicked off by a click. */
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
    draft: { characterId: string; draftId: string } | null;
    draftDescriptor: ClipDraft | null;
    draftFrame: number;
    repair: RepairState | null;
    repairRevision: number;
    tool: 'paint' | 'erase' | 'rect' | 'eyedropper';
    brushColor: string;
    brushSize: number;
    scope: 'frame' | 'clip';
  } = {
    mode: 'clip',
    scan: null,
    recordingId: null,
    frame: 0,
    cutList: null,
    draft: null,
    draftDescriptor: null,
    draftFrame: 0,
    repair: null,
    repairRevision: 0,
    tool: 'paint',
    brushColor: '#ff0000',
    brushSize: 1,
    scope: 'frame',
  };

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

    rail.appendChild(subheading('Drafts'));
    const drafts = make('div', 'list');
    drafts.dataset.librarySection = 'drafts';
    for (const character of state.scan?.characters ?? []) {
      for (const draft of character.drafts) {
        const item = make('button', 'asset');
        item.dataset.draft = draft.id;
        item.dataset.draftCharacter = character.id;
        item.classList.toggle(
          'sel',
          state.draft?.characterId === character.id && state.draft.draftId === draft.id,
        );
        item.append(
          make('span', 'asset-name', draft.id),
          make('span', 'asset-sub', character.id),
        );
        item.addEventListener('click', () => {
          lastLoad = loadDraft(character.id, draft.id);
        });
        drafts.appendChild(item);
      }
    }
    rail.appendChild(drafts);

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
      return clipEditorView();
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

  /**
   * The Clip-editor stage: the active Draft's frames, frame-by-frame.
   *
   * The frame index is the unit; the stage shows the Draft's actual
   * de-backgrounded PNG (served by the Node boundary) and lets the user step
   * and jump between frames. With no Draft active it shows an empty state.
   */
  function clipEditorView(): HTMLElement {
    const view = make('div', 'stage-view');
    view.dataset.stageView = 'clip-editor';
    const draft = state.draftDescriptor;
    if (!state.draft || !draft) {
      view.dataset.emptyState = 'clip-editor';
      view.appendChild(
        make('p', 'muted', 'Clip editor — select a Draft in the Library to view its frames.'),
      );
      return view;
    }

    const { characterId, draftId } = state.draft;
    const viewer = make('div', 'draft-viewer');
    viewer.dataset.draftViewer = '';
    viewer.dataset.character = characterId;
    viewer.dataset.draft = draftId;
    viewer.dataset.activeFrame = String(state.draftFrame);

    const prev = make('button', 'btn ghost', '◀') as HTMLButtonElement;
    prev.dataset.frameStep = 'prev';
    prev.disabled = state.draftFrame <= 0;
    prev.addEventListener('click', () => stepDraftFrame(-1));

    const img = document.createElement('img');
    img.className = 'draft-frame';
    img.dataset.draftFrame = '';
    img.dataset.frameIndex = String(state.draftFrame);
    img.src = api.frameUrl(characterId, draftId, state.draftFrame, state.repairRevision);
    img.alt = `${draftId} frame ${state.draftFrame}`;
    attachPainting(img);

    const next = make('button', 'btn ghost', '▶') as HTMLButtonElement;
    next.dataset.frameStep = 'next';
    next.disabled = state.draftFrame >= draft.frameCount - 1;
    next.addEventListener('click', () => stepDraftFrame(1));

    const counter = make('span', 'pill');
    counter.dataset.draftFrameCounter = '';
    counter.textContent = `frame ${state.draftFrame} / ${draft.frameCount}`;

    const row = make('div', 'draft-stage');
    row.append(prev, img, next);

    const cells = make('div', 'draft-frames');
    cells.setAttribute('role', 'list');
    for (let index = 0; index < draft.frameCount; index += 1) {
      const cell = make('button', 'cell');
      cell.dataset.draftFrameCell = String(index);
      cell.setAttribute('role', 'listitem');
      cell.title = `frame ${index}`;
      cell.textContent = String(index);
      cell.classList.toggle('sel', index === state.draftFrame);
      cell.addEventListener('click', () => selectDraftFrame(index));
      cells.appendChild(cell);
    }

    viewer.append(row, counter, cells);
    view.appendChild(viewer);
    return view;
  }

  function selectDraftFrame(index: number): void {
    state.draftFrame = index;
    renderStage();
    renderContext();
    renderInspector();
  }

  function stepDraftFrame(delta: number): void {
    const frameCount = state.draftDescriptor?.frameCount ?? 0;
    if (frameCount === 0) {
      return;
    }
    state.draftFrame = Math.max(0, Math.min(frameCount - 1, state.draftFrame + delta));
    renderStage();
    renderContext();
    renderInspector();
  }

  // --- Repair (the Clip editor's brush, eyedropper and operation list) -------
  //
  // No Repair logic lives here: every edit goes through {@link WorkbenchApi},
  // which the Node server turns into a core call. The client only turns pointer
  // gestures into operations and replays the returned state.

  /** The frame range an edit targets: the current frame, or the whole Clip. */
  function targetFrames(): { start: number; end: number } {
    if (state.scope === 'clip') {
      return { start: 0, end: state.draftDescriptor?.frameCount ?? 0 };
    }
    return { start: state.draftFrame, end: state.draftFrame + 1 };
  }

  /** The pixel under a pointer event, in Canvas coordinates (the frame PNG is the Canvas). */
  function pointerPixel(event: PointerEvent, img: HTMLImageElement): [number, number] {
    const rect = img.getBoundingClientRect();
    const width = img.naturalWidth || rect.width || 1;
    const height = img.naturalHeight || rect.height || 1;
    const x = Math.floor((((event.clientX - rect.left) / (rect.width || 1)) * width));
    const y = Math.floor((((event.clientY - rect.top) / (rect.height || 1)) * height));
    return [x, y];
  }

  /** Attach painting / eyedropper gestures to the frame image. */
  function attachPainting(img: HTMLImageElement): void {
    img.addEventListener('pointerdown', (event) => {
      const tool = state.tool;
      if (tool === 'eyedropper') {
        void pickColor(event as PointerEvent, img);
        return;
      }
      event.preventDefault();
      const start = pointerPixel(event as PointerEvent, img);
      const points: Array<[number, number]> = [start];

      const move = (moveEvent: PointerEvent): void => {
        const point = pointerPixel(moveEvent, img);
        const last = points[points.length - 1]!;
        if (point[0] !== last[0] || point[1] !== last[1]) {
          points.push(point);
        }
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        void commitGesture(tool, start, points);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  /** The eyedropper: sample the current frame's pixel and make it the brush colour. */
  async function pickColor(event: PointerEvent, img: HTMLImageElement): Promise<void> {
    if (!state.draft) {
      return;
    }
    const [x, y] = pointerPixel(event, img);
    const { characterId, draftId } = state.draft;
    const color = await api.sampleRepairColor(characterId, draftId, state.draftFrame, x, y);
    state.brushColor = color;
    // Painting with the picked colour patches; switch to the brush so the next
    // gesture paints rather than sampling again.
    state.tool = 'paint';
    renderInspector();
  }

  /** Turn a gesture into a Repair operation and append it through the API. */
  async function commitGesture(
    tool: 'paint' | 'erase' | 'rect',
    start: [number, number],
    points: Array<[number, number]>,
  ): Promise<void> {
    if (!state.draft) {
      return;
    }
    const frames = targetFrames();
    let operation: RepairOperationInput;
    if (tool === 'rect') {
      const end = points[points.length - 1] ?? start;
      const x = Math.min(start[0], end[0]);
      const y = Math.min(start[1], end[1]);
      operation = {
        tool: 'erase-rect',
        frames,
        geometry: {
          x,
          y,
          width: Math.abs(end[0] - start[0]) + 1,
          height: Math.abs(end[1] - start[1]) + 1,
        },
      };
    } else {
      const brushTool: RepairTool = tool === 'paint' ? 'paint-brush' : 'erase-brush';
      operation = {
        tool: brushTool,
        frames,
        geometry: { points, size: state.brushSize },
        ...(tool === 'paint' ? { color: state.brushColor } : {}),
      };
    }
    const { characterId, draftId } = state.draft;
    state.repair = await api.appendRepairOperation(characterId, draftId, operation);
    state.repairRevision += 1;
    renderStage();
    renderContext();
    renderInspector();
  }

  async function undoRepair(): Promise<void> {
    if (!state.draft) {
      return;
    }
    const { characterId, draftId } = state.draft;
    state.repair = await api.undoRepairOperation(characterId, draftId);
    state.repairRevision += 1;
    renderStage();
    renderInspector();
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
    if (state.draft) {
      contextPill.textContent = `${state.draft.characterId}/${state.draft.draftId} · frame ${state.draftFrame}`;
      return;
    }
    if (state.recordingId) {
      contextPill.textContent = `${state.recordingId} · frame ${state.frame}`;
      return;
    }
    contextPill.textContent = 'no item loaded';
  }

  /**
   * The inspector is **contextual**: its content follows the active mode while
   * the `[data-region="inspector"]` node persists. The Clip editor is the first
   * mode with real content; #28/#30 fill in Alignment/Export.
   */
  function renderInspector(): void {
    inspector.innerHTML = '';
    inspector.dataset.inspectorFor = state.mode;
    inspector.appendChild(heading('Inspector'));

    if (state.mode === 'clip') {
      renderClipInspector();
      return;
    }
    if (state.mode === 'align') {
      inspector.appendChild(
        make('p', 'muted', 'Alignment inspector — per-Clip placement offsets arrive in #28.'),
      );
      return;
    }
    inspector.appendChild(
      make('p', 'muted', 'Export inspector — the live manifest arrives in #30.'),
    );
  }

  /**
   * Clip-editor inspector content: the active Draft's per-frame facts plus a
   * clearly-marked `[data-inspector-section="repair"]` slot that #27 fills with
   * the brush colour/size and the Repair operation list. #27 extends this
   * section; it should not need to rebuild the inspector.
   */
  function renderClipInspector(): void {
    const draftSection = make('section', 'inspector-section');
    draftSection.dataset.inspectorSection = 'draft';
    draftSection.appendChild(subheading('Draft'));

    if (!state.draft || !state.draftDescriptor) {
      draftSection.appendChild(
        make('p', 'muted', 'Select a Draft to inspect its frames.'),
      );
    } else {
      const { characterId, draftId } = state.draft;
      const draft = state.draftDescriptor;
      const list = make('dl', 'kv');
      addRow(list, 'character', characterId);
      addRow(list, 'draft', draftId);
      addRow(list, 'recording', draft.recordingId);
      addRow(
        list,
        'segment',
        `${draft.segment.cutId} [${draft.segment.startFrame}, ${draft.segment.endFrame})`,
      );
      addRow(list, 'frames', String(draft.frameCount));
      addRow(list, 'frame', String(state.draftFrame));
      addRow(list, 'delay', `${draftDelayMs(draft, state.draftFrame)} ms`);
      addRow(list, 'background', draft.background.hex);
      addRow(list, 'loop', String(draft.loop));
      draftSection.appendChild(list);
    }
    inspector.appendChild(draftSection);

    // Repair controls (#27): the brush (colour + size), the eraser, the
    // rectangle clear, the eyedropper, the frame/Clip scope, undo, and the
    // operation list. This extends the #26 slot; the section node is not rebuilt.
    const repairSection = make('section', 'inspector-section');
    repairSection.dataset.inspectorSection = 'repair';
    repairSection.appendChild(subheading('Repair'));
    const controls = make('div', 'repair-controls');
    controls.dataset.repairControls = '';
    renderRepairControls(controls);
    repairSection.appendChild(controls);
    inspector.appendChild(repairSection);
  }

  /** Fill the `[data-repair-controls]` slot: tools, brush settings, warnings, op list. */
  function renderRepairControls(controls: HTMLElement): void {
    if (!state.draft || !state.draftDescriptor) {
      controls.appendChild(make('p', 'muted', 'Select a Draft to repair its frames.'));
      return;
    }

    const tools = make('div', 'repair-tools');
    const toolButton = (tool: typeof state.tool, label: string): void => {
      const button = make('button', 'btn small', label);
      button.dataset.repairTool = tool;
      button.classList.toggle('on', state.tool === tool);
      button.addEventListener('click', () => {
        state.tool = tool;
        renderInspector();
      });
      tools.appendChild(button);
    };
    toolButton('paint', 'Brush');
    toolButton('erase', 'Eraser');
    toolButton('rect', 'Rect');
    toolButton('eyedropper', 'Eyedropper');
    controls.appendChild(tools);

    const settings = make('div', 'repair-settings');
    settings.appendChild(
      labeled('Colour', colorInput(state.brushColor, (value) => {
        state.brushColor = value;
        state.tool = 'paint';
      })),
    );
    settings.appendChild(
      labeled('Size', sizeInput(state.brushSize, (value) => {
        state.brushSize = Math.max(1, Math.round(value));
      })),
    );
    settings.appendChild(
      labeled('Scope', scopeSelect(state.scope, (value) => {
        state.scope = value;
      })),
    );
    controls.appendChild(settings);

    const undo = make('button', 'btn small', 'Undo') as HTMLButtonElement;
    undo.dataset.repairUndo = '';
    undo.disabled = (state.repair?.operations.length ?? 0) === 0;
    undo.addEventListener('click', () => void undoRepair());
    controls.appendChild(undo);

    for (const warning of state.repair?.warnings ?? []) {
      controls.appendChild(warningRow(warning));
    }

    controls.appendChild(make('h4', 'ttl sub', 'Operations'));
    const list = make('ol', 'repair-ops');
    list.dataset.repairOps = '';
    const operations = state.repair?.operations ?? [];
    if (operations.length === 0) {
      list.appendChild(make('li', 'muted', 'No Repair operations yet.'));
    }
    operations.forEach((operation, index) => {
      const item = make('li', 'repair-op');
      item.dataset.repairOp = '';
      item.dataset.repairOpIndex = String(index);
      item.dataset.repairTool = operation.tool;
      const frames = `${operation.frames.start}–${operation.frames.end}`;
      item.textContent = `${operation.tool} · frames [${frames})`;
      list.appendChild(item);
    });
    controls.appendChild(list);
  }

  /** A Draft frame's delay: `delaysMs` is either uniform (1) or per-frame. */
  function draftDelayMs(draft: ClipDraft, frame: number): number {
    const index = Math.min(frame, draft.delaysMs.length - 1);
    return draft.delaysMs[index] ?? draft.delaysMs[0] ?? 0;
  }

  // --- wiring ---------------------------------------------------------------
  function setMode(mode: WorkbenchMode): void {
    state.mode = mode;
    root.dataset.mode = mode;
    for (const button of modeButtons) {
      button.classList.toggle('on', button.dataset.mode === mode);
    }
    // The stage swaps; the inspector re-renders contextually (same region node).
    renderStage();
    renderInspector();
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

  async function loadDraft(characterId: string, draftId: string): Promise<void> {
    state.draft = { characterId, draftId };
    state.draftFrame = 0;
    state.repairRevision = 0;
    state.draftDescriptor = await api.readClipDraft(characterId, draftId);
    state.repair = await api.readRepair(characterId, draftId);
    renderLibrary();
    renderStage();
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
    get activeDraft() {
      return state.draft;
    },
    get activeDraftFrame() {
      return state.draftFrame;
    },
    get repair() {
      return state.repair;
    },
    setMode,
    loadRecording,
    loadDraft,
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

/** A labelled form field wrapper. */
function labeled(text: string, control: HTMLElement): HTMLElement {
  const wrap = make('label', 'field');
  wrap.append(make('span', 'field-label', text), control);
  return wrap;
}

/** The brush colour input (`[data-repair-color]`). */
function colorInput(value: string, onChange: (value: string) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'color';
  input.setAttribute('data-repair-color', '');
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

/** The brush size input (`[data-repair-size]`). */
function sizeInput(value: number, onChange: (value: number) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.setAttribute('data-repair-size', '');
  input.value = String(value);
  input.addEventListener('input', () => onChange(Number(input.value)));
  return input;
}

/** The edit scope select (`[data-repair-scope]`): the current frame or the whole Clip. */
function scopeSelect(
  value: 'frame' | 'clip',
  onChange: (value: 'frame' | 'clip') => void,
): HTMLSelectElement {
  const select = document.createElement('select');
  select.setAttribute('data-repair-scope', '');
  for (const scope of ['frame', 'clip'] as const) {
    const option = document.createElement('option');
    option.value = scope;
    option.textContent = scope === 'frame' ? 'Current frame' : 'Whole Clip';
    option.selected = scope === value;
    select.appendChild(option);
  }
  select.addEventListener('change', () => onChange(select.value as 'frame' | 'clip'));
  return select;
}

/** A Repair-validity warning row (`[data-repair-warning="<code>"]`). */
function warningRow(warning: RepairWarning): HTMLElement {
  const row = make('p', 'repair-warning', warning.message);
  row.setAttribute('data-repair-warning', warning.code);
  return row;
}
