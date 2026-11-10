/**
 * The browser workbench shell.
 *
 *   rail (Library) | [ modes, stage, filmstrip ] | inspector (contextual)
 *
 * The shell owns the four persistent regions, the state object and the wiring
 * between them; each region's content lives in its own module under
 * `./workbench/`. A view receives a {@link WorkbenchContext} and never imports a
 * sibling, so the collaboration surface is that one interface.
 *
 * The **mode switch swaps only the stage**. Which *thing* is open is the
 * `target`, not the mode: a Recording and a Draft both live in the clip face, so
 * cutting and repairing stay on one screen. Nothing here holds business logic —
 * every read and write goes through {@link WorkbenchApi}, which the Node server
 * turns into core calls.
 */

import type { WorkbenchApi } from './api.js';
import type { WorkbenchContext } from './workbench/context.js';
import { make } from './workbench/dom.js';
import { renderInspector as inspectorView } from './workbench/inspector.js';
import { renderLibrary as libraryView } from './workbench/library.js';
import { renderFilmstrip as filmstripView } from './workbench/filmstrip.js';
import { alignmentStageView } from './workbench/stageAlign.js';
import { clipStageView } from './workbench/stageClip.js';
import { exportStageView } from './workbench/stageExport.js';
import { createState, slugifyId, WORKBENCH_MODES } from './workbench/state.js';
import type { WorkbenchMode, WorkbenchState } from './workbench/state.js';

export { slugifyId };
export type { WorkbenchMode, WorkbenchState };

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
  /** The active Recording frame index (the scrub unit), `0` when none. */
  readonly activeFrame: number;
  /** The active Draft as `{characterId, draftId}`, or `null`. */
  readonly activeDraft: { characterId: string; draftId: string } | null;
  /** The active Draft frame index (the Clip-editor unit); `0` when none. */
  readonly activeDraftFrame: number;
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
    // These are toggles of one stage, not links: the pressed state is what tells a
    // screen reader which face is up.
    button.setAttribute('aria-pressed', 'false');
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

  // --- context --------------------------------------------------------------
  let lastLoad: Promise<void> = Promise.resolve();

  const ctx: WorkbenchContext = {
    api,
    state,
    root,
    regions: { rail, stage, filmstrip, inspector, context: contextPill },

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

  function renderStage(): void {
    // Contract: only the stage's contents change here. The rail, inspector and
    // filmstrip nodes are never touched by a mode switch.
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
    if (state.mode === 'align') {
      return alignmentStageView(ctx);
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
    if (state.recordingId) {
      contextPill.textContent = `${state.recordingId} · frame ${state.frame}`;
      return;
    }
    contextPill.textContent = 'no item loaded';
  }

  // --- modes ----------------------------------------------------------------
  function setMode(mode: WorkbenchMode): void {
    state.mode = mode;
    root.dataset.mode = mode;
    for (const button of modeButtons) {
      const on = button.dataset.mode === mode;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    renderStage();
    renderInspector();

    // Entering Alignment loads the Character's Canvas and offsets.
    if (mode === 'align') {
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
    // Entering Export refreshes the live manifest of the loaded target.
    if (mode === 'export' && state.target.kind === 'export') {
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
    state.cutList = await api.readCutList(recordingId);
    state.loadError = null;
    if (state.mode !== 'clip') {
      setMode('clip');
    }
    renderLibrary();
    renderStage();
    renderFilmstrip();
    renderContext();
    renderInspector();
  }

  async function readDraft(characterId: string, draftId: string): Promise<void> {
    state.target = { kind: 'draft', characterId, draftId };
    state.activeCharacterId = characterId;
    state.draftFrame = 0;
    state.repairRevision = 0;
    state.draftDescriptor = await api.readClipDraft(characterId, draftId);
    state.repair = await api.readRepair(characterId, draftId);
    state.loadError = null;
    if (state.mode !== 'clip') {
      setMode('clip');
    }
    renderLibrary();
    renderStage();
    renderContext();
    renderInspector();
  }

  async function readAlignment(characterId: string): Promise<void> {
    state.activeCharacterId = characterId;
    state.alignment = await api.readCharacterAlignment(characterId);
    if (state.alignment) {
      state.expandWidth = state.alignment.canvas.width;
      state.expandHeight = state.alignment.canvas.height;
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
    state.assetFrame = 0;
    state.reproducible = null;
    state.asset =
      assetKind === 'clip'
        ? await api.readClip(characterId, assetId)
        : await api.readSequence(characterId, assetId);
    // Opening an Asset drops you on the face that can act on it: the clip face for
    // playback and fork, the alignment face for a Sequence's composition.
    state.loadError = null;
    if (state.mode !== 'clip') {
      setMode('clip');
    }
    renderLibrary();
    renderStage();
    renderContext();
    renderInspector();
  }

  async function readExport(target: string): Promise<void> {
    state.target = { kind: 'export', target };
    state.manifest = await api.readManifest(target);
    state.loadError = null;
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
  setMode('clip');
  renderLibrary();
  renderFilmstrip();
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
    loadAlignment: openAlignment,
    loadExport: openExport,
    settled: () => lastLoad,
  };
}
