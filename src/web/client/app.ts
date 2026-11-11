/**
 * The browser workbench shell.
 *
 *   header (context · faces)
 *   rail (Library) | stage (display + its tools) | inspector (contextual)
 *                  | filmstrip (only where a face has a time axis)
 *
 * The shell owns the persistent regions, the state object and the wiring between
 * them; each region's content lives in its own module under `./workbench/`. A
 * view receives a {@link WorkbenchContext} and never imports a sibling, so the
 * collaboration surface is that one interface.
 *
 * The **mode switch swaps only the stage**. Which *thing* is open is the
 * `target`, not the mode: a Recording and a Draft both live in the clip face, so
 * cutting and repairing stay on one screen. Nothing here holds business logic —
 * every read and write goes through {@link WorkbenchApi}, which the Node server
 * turns into core calls.
 *
 * The faces live in the shell header rather than inside the stage. A face switch
 * must not rebuild the chrome around the work, and the breadcrumb is chrome: it
 * names what is open, not what the stage is drawing.
 */

import type { WorkbenchApi } from './api.js';
import type { WorkbenchContext } from './workbench/context.js';
import type { CutSession, CutSessionDeps } from './workbench/cutSession.js';
import { createCutSession } from './workbench/cutSession.js';
import { createDraftEditor } from './workbench/draftEditor.js';
import { make } from './workbench/dom.js';
import { renderInspector as inspectorView } from './workbench/inspector.js';
import { renderLibrary as libraryView } from './workbench/library.js';
import { paintPlayButton, renderFilmstrip as filmstripView, updateFrame } from './workbench/filmstrip.js';
import { alignmentStageView } from './workbench/stageAlign.js';
import { clipStageView } from './workbench/stageClip.js';
import { composeStageView } from './workbench/stageCompose.js';
import { cutStageView } from './workbench/stageCut.js';
import { exportStageView } from './workbench/stageExport.js';
import { assetStageView } from './workbench/stageView.js';
import { createState, defaultFace, facesFor, slugifyId, activeCharacter, GLOBAL_FACES } from './workbench/state.js';
import type { GlobalFace, WorkbenchMode, WorkbenchState } from './workbench/state.js';

export { slugifyId };
export type { WorkbenchMode, WorkbenchState };

/**
 * One word each: the faces read as a set of views of the open target, not as
 * sentences.
 */
const MODE_LABEL: Record<WorkbenchMode, string> = {
  cut: 'Cut',
  clip: 'Clip',
  align: 'Align',
  view: 'View',
  compose: 'Compose',
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
  /** The active Recording frame index (the scrub unit), `0` when none. */
  readonly activeFrame: number;
  /** The active Draft as `{characterId, draftId}`, or `null`. */
  readonly activeDraft: { characterId: string; draftId: string } | null;
  /** The active Draft frame index (the Clip-editor unit); `0` when none. */
  readonly activeDraftFrame: number;
  /** Screen pixels per image pixel on the frame, or `null` while it is fitted. */
  readonly draftZoom: number | null;
  /** The brush size in the frame's own pixels. */
  readonly brushSize: number;
  /** The active Draft's Repair state (operations + warnings), or `null`. */
  readonly repair: WorkbenchState['repair'];
  /** The active Character's Canvas and per-Clip offsets (Alignment stage), or `null`. */
  readonly alignment: WorkbenchState['alignment'];
  /** The loaded Export target, or `null`. */
  readonly activeExport: string | null;
  /** The live Export Manifest (Export stage), or `null`. */
  readonly manifest: WorkbenchState['manifest'];
  /** Switch mode; swaps the stage and re-renders the contextual inspector. */
  setMode(mode: WorkbenchMode): void;
  /** Load a Recording: read its cut list and show it in the filmstrip. */
  loadRecording(recordingId: string): Promise<void>;
  /** Load a Draft: read its descriptor and show its frames in the Clip editor. */
  loadDraft(characterId: string, draftId: string): Promise<void>;
  /** Open a Character: its Alignment face, where its Canvas is framed. */
  loadCharacter(characterId: string): Promise<void>;
  /** Load a Character's alignment view: its Canvas and every Clip/Draft offset. */
  loadAlignment(characterId: string): Promise<void>;
  /** Load an Export: read and show its live, validated Manifest. */
  loadExport(target: string): Promise<void>;
  /** Await the most recent load kicked off by a click or a form. */
  settled(): Promise<void>;
}

/** Mount the workbench into `container`, returning a handle to it. */
export function mountWorkbench(
  container: HTMLElement,
  options: WorkbenchOptions,
): WorkbenchHandle {
  const { api } = options;
  container.innerHTML = '';

  const state = createState();

  // --- shell ----------------------------------------------------------------
  const root = make('div', 'workbench hero-text');
  // The shell is one render of the product: framed by the page's container, but
  // its panes and bars inside are the mock's own layout, not the page's columns.
  // (`site/` is not in the gate's fingerprinted set, so this file carries the
  // note that a stale result can be told apart by.)
  root.dataset.product = '';
  root.dataset.mode = state.mode;

  // The header is the shell's and **global**: it carries only the faces that do
  // not belong to the open item. Composition and Export both hang off the
  // Character, so they survive every target; a target's own faces live on the bar
  // above the stage, which travels with it.
  const header = make('header', 'context-bar');
  header.dataset.region = 'context-bar';
  const globalFaces = make('nav', 'faces global-faces');
  globalFaces.dataset.region = 'global-faces';
  header.append(globalFaces);

  const body = make('div', 'shell-body');

  const rail = make('aside', 'rail');
  rail.dataset.region = 'rail';

  // The middle pane is the product itself: the stage, its bar and its filmstrip
  // are one render, framed by the two side panels rather than laid out on the
  // page's column lines.
  const centre = make('div', 'centre');

  // The target bar: what is open, and the faces that belong to it. It sits with
  // the stage so the header never has to change when the target does.
  const targetBar = make('div', 'target-bar');
  targetBar.dataset.region = 'target-bar';
  const contextPill = make('span', 'pill');
  contextPill.dataset.region = 'context';
  const faces = make('nav', 'faces target-faces');
  faces.dataset.region = 'faces';
  // The faces are rebuilt per target: a face only exists while it means
  // something, so they cannot be made once up front.
  const modeButtons: HTMLButtonElement[] = [];
  targetBar.append(contextPill, faces);

  const stage = make('div', 'stage');
  stage.dataset.region = 'stage';

  const filmstrip = make('div', 'filmstrip');
  filmstrip.dataset.region = 'filmstrip';

  const inspector = make('aside', 'inspector');
  inspector.dataset.region = 'inspector';

  centre.append(targetBar, stage, filmstrip);
  body.append(rail, centre, inspector);
  root.append(header, body);
  container.appendChild(root);

  // --- context --------------------------------------------------------------
  let lastLoad: Promise<void> = Promise.resolve();

  // The two sessions are built once, before any render; their deps are closures
  // over the functions below, so a detached control still reaches the same rules.
  let cut: CutSession;
  const cutDeps: CutSessionDeps = {
    api,
    state,
    regions: { rail, stage, filmstrip },
    render: {
      library: () => renderLibrary(),
      stage: () => renderStage(),
      filmstrip: () => renderFilmstrip(),
      inspector: () => renderInspector(),
      context: () => renderContext(),
    },
    run,
    showFrame: (index) => {
      state.frame = index;
      updateFrame(ctx);
    },
    playStateChanged: () => paintPlayButton(ctx),
    stop: () => cut.stop(),
    loadDraft: openDraft,
    loadRecording: openRecording,
    rescan,
  };
  cut = createCutSession(cutDeps);

  const draft = createDraftEditor({
    api,
    state,
    regions: { stage, inspector },
    run,
    renderStage,
    renderInspector,
    renderContext,
    setMode,
    loadAsset: openAsset,
    loadAlignment: openAlignment,
    rescan,
  });

  const ctx: WorkbenchContext = {
    api,
    state,
    root,
    regions: { rail, stage, filmstrip, inspector, header, targetBar, context: contextPill },
    cut,
    cutDeps,
    draft,

    render() {
      renderLibrary();
      renderStage();
      renderFilmstrip();
      renderContext();
      renderInspector();
    },
    renderLibrary,
    renderStage,
    renderFilmstrip,
    renderInspector,
    renderContext,

    loadRecording: openRecording,
    loadDraft: openDraft,
    loadAsset: openAsset,
    loadCharacter,
    loadAlignment: openAlignment,
    loadExport: openExport,
    run,
    setMode,
    rescan,
    track,
  };

  // --- rendering ------------------------------------------------------------
  function renderLibrary(): void {
    libraryView(ctx);
  }

  /**
   * Rebuild the two face bars.
   *
   * The header keeps the global faces (Composition, Export) and only changes when
   * whether they can be used does: without a Character in play there is nothing to
   * compose or export. The bar above the stage is rebuilt per target. On either
   * bar, a face that is the only one is where you are, so it reads as a label
   * rather than as a button that does nothing when pressed.
   */
  function renderModes(): void {
    renderGlobalFaces();
    renderTargetFaces();
  }

  function renderGlobalFaces(): void {
    globalFaces.innerHTML = '';
    const characterId = activeCharacter(state);
    for (const mode of GLOBAL_FACES) {
      const button = make('button', 'btn') as HTMLButtonElement;
      button.dataset.mode = mode;
      button.textContent = MODE_LABEL[mode];
      button.classList.toggle('on', mode === state.mode);
      // Both faces are about a Character; with none open there is no subject.
      button.disabled = characterId === null;
      button.title =
        characterId === null ? `${MODE_LABEL[mode]} — pick a Character first` : MODE_LABEL[mode];
      button.setAttribute('aria-pressed', String(mode === state.mode));
      button.addEventListener('click', () => activateGlobal(mode, characterId));
      globalFaces.appendChild(button);
    }
  }

  function renderTargetFaces(): void {
    // The bar is rebuilt wholesale, so a label left from a single-face target goes
    // the same way the buttons do.
    faces.innerHTML = '';
    modeButtons.length = 0;

    const available = facesFor(state.target);
    if (available.length === 1) {
      const only = available[0]!;
      // A lone face the header already carries (Export on an Export target) would
      // be the same word twice, so the bar keeps only its breadcrumb.
      if ((GLOBAL_FACES as readonly WorkbenchMode[]).includes(only)) {
        return;
      }
      if (state.mode === only) {
        const label = make('span', 'face-label', MODE_LABEL[only]);
        label.dataset.mode = only;
        faces.appendChild(label);
        return;
      }
      // A lone face is not where you are while a global face is up: it is the way
      // back, so it is a button there.
      const back = make('button', 'btn') as HTMLButtonElement;
      back.dataset.mode = only;
      back.textContent = MODE_LABEL[only];
      back.addEventListener('click', () => setMode(only));
      faces.appendChild(back);
      modeButtons.push(back);
      return;
    }
    for (const mode of available) {
      const button = make('button', 'btn') as HTMLButtonElement;
      button.dataset.mode = mode;
      button.textContent = MODE_LABEL[mode];
      button.classList.toggle('on', mode === state.mode);
      // These are toggles of one stage, not links: the pressed state is what tells
      // a screen reader which face is up.
      button.setAttribute('aria-pressed', String(mode === state.mode));
      button.addEventListener('click', () => setMode(mode));
      faces.appendChild(button);
      modeButtons.push(button);
    }
  }

  /**
   * Go to a global face.
   *
   * Composition is the Character's own work, so it opens the Character when
   * something else is up — that is a jump, not a face switch, and the target bar
   * has to follow it. Export works against the Character already in play.
   */
  function activateGlobal(mode: GlobalFace, characterId: string | null): void {
    if (characterId === null) {
      return;
    }
    if (mode === 'compose' && state.target.kind !== 'character') {
      void track(loadCharacter(characterId)).then(() => setMode('compose'));
      return;
    }
    setMode(mode);
  }

  function renderStage(): void {
    // Contract: a mode switch touches the stage's contents and nothing else. The
    // rail, the header (breadcrumb and faces), the inspector and the filmstrip
    // node all survive it.
    stage.innerHTML = '';
    // A failed load leaves the stage showing why, so a rejected artifact never
    // looks like a dead button.
    if (state.loadError !== null) {
      stage.appendChild(loadErrorBanner());
    }
    if (state.actionError !== null) {
      stage.appendChild(actionErrorBanner());
    }
    stage.appendChild(stageView());
  }

  function stageView(): HTMLElement {
    if (state.mode === 'cut') {
      return cutStageView(ctx);
    }
    if (state.mode === 'align') {
      return alignmentStageView(ctx);
    }
    if (state.mode === 'view') {
      return assetStageView(ctx);
    }
    if (state.mode === 'compose') {
      return composeStageView(ctx);
    }
    if (state.mode === 'export') {
      return exportStageView(ctx);
    }
    return clipStageView(ctx);
  }

  /**
   * The load-failure notice. A load can be rejected by the store's
   * validate-on-read contract (a stale Manifest, a Draft with a broken repair
   * script); without this the click looks like a no-op because only the console
   * ever saw the error.
   */
  function loadErrorBanner(): HTMLElement {
    const banner = make('div', 'load-error');
    banner.dataset.loadError = '';
    banner.setAttribute('role', 'alert');
    banner.append(
      make('strong', 'load-error-title', 'Load failed'),
      make('p', 'load-error-message', state.loadError ?? ''),
    );
    return banner;
  }

  /** The action-failure notice: the same treatment for a refused edit. */
  function actionErrorBanner(): HTMLElement {
    const banner = make('div', 'load-error action-error');
    banner.dataset.actionError = '';
    banner.setAttribute('role', 'alert');
    banner.append(
      make('strong', 'load-error-title', 'Action failed'),
      make('p', 'load-error-message', state.actionError ?? ''),
      dismissButton(() => {
        state.actionError = null;
        renderStage();
      }),
    );
    return banner;
  }

  /** A small "dismiss" control for a notice. */
  function dismissButton(dismiss: () => void): HTMLElement {
    const button = make('button', 'btn small ghost', 'Dismiss');
    button.dataset.dismissError = '';
    button.addEventListener('click', dismiss);
    return button;
  }

  function renderFilmstrip(): void {
    // The strip is the cut face's timeline: a Draft or an Export has nothing to
    // scrub here, so it would only take height away from them. Collapsed, it
    // keeps a hairline so the layout does not jump when the face changes.
    const wanted = state.mode === 'cut';
    filmstrip.hidden = !wanted;
    if (!wanted) {
      filmstrip.innerHTML = '';
      return;
    }
    filmstripView(ctx);
  }

  function renderInspector(): void {
    inspectorView(ctx);
  }

  function renderContext(): void {
    if (state.target.kind === 'draft') {
      contextPill.textContent = `${state.target.characterId}/${state.target.draftId} · frame ${state.draftFrame}`;
      return;
    }
    if (state.target.kind === 'asset') {
      contextPill.textContent = `${state.target.characterId}/${state.target.assetId} · ${state.target.assetKind} · frame ${state.assetFrame}`;
      return;
    }
    if (state.target.kind === 'export') {
      contextPill.textContent = `export ${state.target.target}`;
      return;
    }
    if (state.target.kind === 'character') {
      contextPill.textContent = `character ${state.target.characterId}`;
      return;
    }
    if (state.recordingId) {
      contextPill.textContent = `${state.recordingId} · frame ${state.frame}`;
      return;
    }
    contextPill.textContent = 'no item loaded';
  }

  // --- modes ----------------------------------------------------------------
  /**
   * The faces available right now: the target's own, plus the global ones while a
   * Character is in play (they have no subject without one).
   */
  function availableFaces(): WorkbenchMode[] {
    const local = [...facesFor(state.target)];
    return activeCharacter(state) === null ? local : [...local, ...GLOBAL_FACES];
  }

  function setMode(mode: WorkbenchMode): void {
    const from = state.mode;
    // A face only exists while the open target (or Character) has it, so a request
    // for a face it does not have falls back to the target's opening face instead
    // of a blank one.
    state.mode = availableFaces().includes(mode) ? mode : defaultFace(state.target);
    root.dataset.mode = state.mode;
    renderModes();
    renderStage();
    renderFilmstrip();
    renderInspector();
    // The pill names what the face is showing, so a mode change refreshes it too.
    renderContext();

    // Entering Alignment loads the Character's Canvas and offsets.
    if (state.mode === 'align') {
      const characterId =
        state.target.kind === 'draft'
          ? state.target.characterId
          : state.target.kind === 'asset'
            ? state.target.characterId
            : (state.activeCharacterId ?? state.scan?.characters[0]?.id ?? null);
      if (characterId) {
        track(loadAlignment(characterId));
      }
    }
    // Entering Export refreshes the live manifest. A load ends by opening its own
    // face, so this only fires on the transition — otherwise the read would
    // re-enter itself forever.
    if (from !== 'export' && state.mode === 'export' && state.target.kind === 'export') {
      track(loadExport(state.target.target));
    }
  }

  /** Record a promise so {@link WorkbenchHandle.settled} can await it. */
  function track(promise: Promise<void>): Promise<void> {
    lastLoad = promise;
    return promise;
  }

  /**
   * Run a user action and turn a rejection into visible state.
   *
   * A refused edit is not a lost load: the stage keeps its content and the notice
   * sits above it, dismissable, so the work in progress survives.
   */
  function run(label: string, body: () => Promise<void>): Promise<void> {
    state.actionError = null;
    const promise = body().catch((error: unknown) => {
      state.actionError = `${label}: ${error instanceof Error ? error.message : String(error)}`;
      renderStage();
      renderInspector();
    });
    return track(promise);
  }

  /**
   * Run a load and turn a rejection into visible state.
   *
   * Every store read is validate-on-read, so a load can fail for reasons the user
   * can fix (a Manifest older than the Canvas, a revised repair script). `reset`
   * drops whatever the failed load half-assigned so the stage never shows stale
   * content next to the error.
   */
  function guarded(load: () => Promise<void>, reset: () => void): Promise<void> {
    state.loadError = null;
    return load().catch((error: unknown) => {
      reset();
      state.loadError = error instanceof Error ? error.message : String(error);
      renderLibrary();
      renderStage();
      renderInspector();
    });
  }

  // --- reads ----------------------------------------------------------------
  async function readRecording(recordingId: string): Promise<void> {
    state.target = { kind: 'recording', recordingId };
    state.recordingId = recordingId;
    state.frame = 0;
    state.selectedCut = null;
    state.selection = null;
    state.cutList = await api.readCutList(recordingId);
    // Delays feed playback only; a Recording that cannot report them still scrubs,
    // so the fallback is a plain frame rate rather than a failed load.
    state.recordingDelaysMs = await api
      .readRecordingDelays(recordingId)
      .then((delays) => delays.delaysMs)
      .catch(() => []);
    cut.stop();
    state.loadError = null;
    // Cutting is the only face a Recording has, so it is where a load lands.
    setMode(defaultFace(state.target));
    renderLibrary();
    renderStage();
    renderFilmstrip();
    renderContext();
    renderInspector();
  }

  async function readDraft(characterId: string, draftId: string): Promise<void> {
    state.target = { kind: 'draft', characterId, draftId };
    state.activeCharacterId = characterId;
    state.sequenceDraft = null;
    state.draftFrame = 0;
    // A new Draft starts fitted, whatever the last one was zoomed to.
    state.draftZoom = null;
    state.repairRevision = 0;
    state.draftDescriptor = await api.readClipDraft(characterId, draftId);
    state.repair = await api.readRepair(characterId, draftId);
    state.loadError = null;
    setMode(defaultFace(state.target));
    renderLibrary();
    renderStage();
    renderContext();
    renderInspector();
  }

  async function readAlignment(characterId: string): Promise<void> {
    state.activeCharacterId = characterId;
    state.alignment = await api.readCharacterAlignment(characterId);
    // A different Character starts at a scale that fits it, not at the last one's.
    state.alignScale = null;
    if (state.alignment) {
      state.resizeWidth = state.alignment.canvas.width;
      state.resizeHeight = state.alignment.canvas.height;
    }
    if (state.target.kind === 'draft' && state.target.characterId === characterId) {
      const alignment = await api.readDraftAlignment(characterId, state.target.draftId);
      state.alignmentWarnings = alignment.warnings;
    } else {
      state.alignmentWarnings = [];
    }
    state.loadError = null;
    renderStage();
    renderInspector();
  }

  async function readAsset(
    characterId: string,
    assetKind: 'clip' | 'sequence',
    assetId: string,
  ): Promise<void> {
    state.target = { kind: 'asset', characterId, assetKind, assetId };
    state.activeCharacterId = characterId;
    state.sequenceDraft = null;
    state.assetFrame = 0;
    state.reproducible = null;
    state.asset =
      assetKind === 'clip'
        ? await api.readClip(characterId, assetId)
        : await api.readSequence(characterId, assetId);
    // Opening an Asset drops you on the face that can act on it: the clip face for
    // playback and fork, the alignment face for a Sequence's composition.
    state.loadError = null;
    setMode(defaultFace(state.target));
    renderLibrary();
    renderStage();
    renderContext();
    renderInspector();
  }

  async function readExport(target: string): Promise<void> {
    state.target = { kind: 'export', target };
    state.manifest = await api.readManifest(target);
    state.loadError = null;
    setMode(defaultFace(state.target));
    renderLibrary();
    renderStage();
    renderInspector();
  }

  async function rescan(): Promise<void> {
    state.scan = await api.scan();
    renderLibrary();
  }

  // The public loads: a read plus the reset that drops its half-built state when
  // the store rejects it.
  function loadRecording(recordingId: string): Promise<void> {
    return guarded(() => readRecording(recordingId), () => {
      state.cutList = null;
    });
  }

  function loadDraft(characterId: string, draftId: string): Promise<void> {
    return guarded(() => readDraft(characterId, draftId), () => {
      state.draftDescriptor = null;
    });
  }

  function loadAlignment(characterId: string): Promise<void> {
    return guarded(() => readAlignment(characterId), () => {
      state.alignment = null;
    });
  }

  /**
   * Open a Character itself.
   *
   * A Character owns no pixels, only the Canvas every Asset is aligned to, so its
   * one face is Alignment. Setting the target first means the inspector and the
   * mode bar both follow the Character, not whatever was open before.
   */
  function loadCharacter(characterId: string): Promise<void> {
    state.target = { kind: 'character', characterId };
    state.activeCharacterId = characterId;
    // `setMode('align')` already tracks the alignment read for the active
    // Character, so it is the one place the load is kicked off.
    setMode(defaultFace(state.target));
    renderLibrary();
    renderContext();
    return lastLoad;
  }

  function loadExport(target: string): Promise<void> {
    return guarded(() => readExport(target), () => {
      state.manifest = null;
    });
  }

  function loadAsset(
    characterId: string,
    assetKind: 'clip' | 'sequence',
    assetId: string,
  ): Promise<void> {
    return guarded(() => readAsset(characterId, assetKind, assetId), () => {
      state.asset = null;
    });
  }

  // The same loads, tracked: a click-driven load has to be awaitable through
  // `settled()` or a test cannot tell it apart from a dead button.
  function openRecording(recordingId: string): Promise<void> {
    return track(loadRecording(recordingId));
  }
  function openDraft(characterId: string, draftId: string): Promise<void> {
    return track(loadDraft(characterId, draftId));
  }
  function openAlignment(characterId: string): Promise<void> {
    return track(loadAlignment(characterId));
  }
  function openExport(target: string): Promise<void> {
    return track(loadExport(target));
  }
  function openAsset(
    characterId: string,
    assetKind: 'clip' | 'sequence',
    assetId: string,
  ): Promise<void> {
    return track(loadAsset(characterId, assetKind, assetId));
  }

  // --- initial render -------------------------------------------------------
  // Nothing is open, so the only face is the empty Clip editor; `setMode` renders
  // the bar, the stage and the filmstrip together.
  setMode(defaultFace(state.target));
  renderLibrary();
  renderContext();
  renderInspector();

  const ready = rescan();

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
      return state.target.kind === 'draft'
        ? { characterId: state.target.characterId, draftId: state.target.draftId }
        : null;
    },
    get activeDraftFrame() {
      return state.draftFrame;
    },
    get draftZoom() {
      return state.draftZoom;
    },
    get brushSize() {
      return state.brushSize;
    },
    get repair() {
      return state.repair;
    },
    get alignment() {
      return state.alignment;
    },
    get activeExport() {
      return state.target.kind === 'export' ? state.target.target : null;
    },
    get manifest() {
      return state.manifest;
    },
    setMode,
    loadRecording: openRecording,
    loadDraft: openDraft,
    loadCharacter,
    loadAlignment: openAlignment,
    loadExport: openExport,
    settled: () => lastLoad,
  };
}
