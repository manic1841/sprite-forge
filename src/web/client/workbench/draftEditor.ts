/**
 * The Draft editor: the frame, the Repair gestures, the log, and the two exits.
 *
 * A Draft is one screen's worth of work, so the pixels, the tools that write
 * them, the record of what was written and the way out all belong to one
 * module. The clip stage and the inspector only mount the parts of it they own;
 * no caller has to know how a gesture becomes an operation.
 *
 * Two jobs have their own module and the editor composes them: the sheet's size
 * and zoom (`draftSheet`) and the gestures that write pixels (`repairTools`).
 * What stays here is the frame board's assembly and the two ways out.
 *
 * The editor owns the `DraftState` slice and is its only writer.
 */

import type { WorkbenchApi } from '../api.js';
import type { RepairWarning } from '../types.js';
import { confirmAction } from './dialog.js';
import {
  applySheetSize,
  attachDraftZoom,
  refitOnResize,
  zoomControls,
  type SheetDeps,
} from './draftSheet.js';
import { colorInput, labeled, make, scopeSelect, sizeInput } from './dom.js';
import { attachFootprint, attachPainting, undoRepair, type RepairDeps } from './repairTools.js';
import type { WorkbenchState } from './state.js';

export { DRAFT_ZOOM_MAX, DRAFT_ZOOM_STEP, draftScaleFor, type FitContext } from './draftSheet.js';
export { targetFrames } from './repairTools.js';

/** What the editor needs from the shell. */
export interface DraftEditorDeps {
  readonly api: WorkbenchApi;
  readonly state: WorkbenchState;
  readonly regions: { stage: HTMLElement; inspector: HTMLElement };
  readonly run: (label: string, body: () => Promise<void>) => void;
  renderStage(): void;
  renderInspector(): void;
  renderContext(): void;
  setMode(mode: WorkbenchState['mode']): void;
  loadAsset(characterId: string, assetKind: 'clip' | 'sequence', assetId: string): Promise<void>;
  loadAlignment(characterId: string): Promise<void>;
  rescan(): Promise<void>;
}

/** The editor's verbs, as the two regions that mount it see them. */
export interface DraftEditor {
  /** The frame board, tools, status and frame cells. */
  renderView(): HTMLElement;
  /** The tool bar under the frame. */
  repairBar(): HTMLElement;
  /** The replay log and its warnings. */
  repairLog(): HTMLElement;
  /** Commit the Draft into an immutable Clip. */
  commitSection(): HTMLElement;
  /** Throw the Draft away. */
  discardSection(): HTMLElement;
}

/** Create the editor bound to one shell. */
export function createDraftEditor(deps: DraftEditorDeps): DraftEditor {
  const { api, state } = deps;

  // Both sub-modules need a narrower set than the editor's deps, which serve both.
  const sheet: SheetDeps = deps;
  const repair: RepairDeps = deps;

  function warningRow(warning: RepairWarning): HTMLElement {
    const row = make('p', 'repair-warning', warning.message);
    row.setAttribute('data-repair-warning', warning.code);
    return row;
  }

  // --- the mounted parts ----------------------------------------------------

  function repairBar(): HTMLElement {
    const bar = make('div', 'repair-bar');
    bar.dataset.repairBar = '';

    const tools = make('div', 'repair-tools');
    const toolButton = (tool: typeof state.tool, label: string): void => {
      const button = make('button', 'btn small', label);
      button.dataset.repairTool = tool;
      button.classList.toggle('on', state.tool === tool);
      button.setAttribute('aria-pressed', String(state.tool === tool));
      button.addEventListener('click', () => {
        state.tool = tool;
        deps.renderStage();
      });
      tools.appendChild(button);
    };
    toolButton('paint', 'Brush');
    toolButton('erase', 'Eraser');
    toolButton('rect', 'Rect');
    toolButton('eyedropper', 'Eyedropper');
    bar.appendChild(tools);

    const settings = make('div', 'repair-settings');
    settings.appendChild(
      labeled(
        'Colour',
        colorInput(state.brushColor, (value) => {
          state.brushColor = value;
          state.tool = 'paint';
        }),
      ),
    );
    settings.appendChild(
      labeled(
        // The unit is the frame's own pixels, not screen ones, which is why the view
        // has to be able to show them at 1× or more.
        'Size (px)',
        sizeInput(state.brushSize, (value) => {
          state.brushSize = value;
        }),
      ),
    );
    settings.appendChild(
      labeled(
        'Scope',
        scopeSelect(state.scope, (value) => {
          state.scope = value;
        }),
      ),
    );
    bar.appendChild(settings);

    const undo = make('button', 'btn small', 'Undo') as HTMLButtonElement;
    undo.dataset.repairUndo = '';
    undo.disabled = (state.repair?.operations.length ?? 0) === 0;
    undo.addEventListener('click', () => deps.run('Undo repair', () => undoRepair(repair)));
    bar.appendChild(undo);

    return bar;
  }

  function repairLog(): HTMLElement {
    const log = make('div', 'repair-log');
    log.dataset.repairLog = '';

    for (const warning of state.repair?.warnings ?? []) {
      log.appendChild(warningRow(warning));
    }

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
      item.textContent = `${operation.tool} · frames [${operation.frames.start}–${operation.frames.end})`;
      list.appendChild(item);
    });
    log.appendChild(list);

    return log;
  }

  // --- the frame board ------------------------------------------------------

  function renderView(): HTMLElement {
    const draft = state.draftDescriptor;
    const target = state.target.kind === 'draft' ? state.target : null;
    if (!draft || !target) {
      const view = make('div', 'stage-view');
      view.dataset.stageView = 'clip-editor';
      view.appendChild(make('p', 'muted', 'Select a Draft in the Library to view its frames.'));
      return view;
    }

    const view = make('div', 'stage-view');
    view.dataset.stageView = 'clip-editor';

    const viewer = make('div', 'draft-viewer');
    viewer.dataset.draftViewer = '';
    viewer.dataset.character = target.characterId;
    viewer.dataset.draft = target.draftId;
    viewer.dataset.activeFrame = String(state.draftFrame);

    const prev = make('button', 'btn ghost', '◀') as HTMLButtonElement;
    prev.dataset.frameStep = 'prev';
    prev.disabled = state.draftFrame <= 0;
    prev.addEventListener('click', () => stepFrame(-1));

    const img = document.createElement('img');
    img.className = 'draft-frame';
    img.dataset.draftFrame = '';
    img.dataset.frameIndex = String(state.draftFrame);
    img.src = api.frameUrl(
      target.characterId,
      target.draftId,
      state.draftFrame,
      state.repairRevision,
    );
    img.alt = `${target.draftId} frame ${state.draftFrame}`;
    attachPainting(repair, img);

    // The footprint overlay: same size as the image, so one of its pixels is one
    // pixel of the frame. Purely visual, so pointers pass through it.
    const overlay = document.createElement('canvas');
    overlay.className = 'draft-overlay';
    overlay.dataset.draftOverlay = '';
    overlay.setAttribute('aria-hidden', 'true');

    const sheetEl = make('div', 'draft-sheet');
    sheetEl.dataset.draftSheet = '';
    sheetEl.append(img, overlay);

    const board = make('div', 'draft-board');
    board.dataset.draftBoard = '';
    board.appendChild(sheetEl);
    attachFootprint(repair, img, overlay);
    attachDraftZoom(sheet, board, sheetEl, img);

    const next = make('button', 'btn ghost', '▶') as HTMLButtonElement;
    next.dataset.frameStep = 'next';
    next.disabled = state.draftFrame >= draft.frameCount - 1;
    next.addEventListener('click', () => stepFrame(1));

    const counter = make('span', 'pill');
    counter.dataset.draftFrameCounter = '';
    counter.textContent = `frame ${state.draftFrame} / ${draft.frameCount}`;

    const readout = make('span', 'pill draft-cursor');
    readout.dataset.draftCursor = '';
    readout.title = 'pixel under the pointer';
    readout.textContent = '—';

    const row = make('div', 'draft-stage');
    row.append(prev, board, next);
    // The tools hang under the frame they paint on; the inspector keeps the log.
    const bar = repairBar();

    const status = make('div', 'draft-status');
    const zoom = zoomControls(sheet, board, img);
    status.append(counter, readout, zoom.group);

    const cells = make('div', 'draft-frames');
    cells.setAttribute('role', 'list');
    for (let index = 0; index < draft.frameCount; index += 1) {
      const cell = make('button', 'cell');
      cell.dataset.draftFrameCell = String(index);
      cell.setAttribute('role', 'listitem');
      cell.title = `frame ${index}`;
      cell.textContent = String(index);
      cell.classList.toggle('sel', index === state.draftFrame);
      cell.addEventListener('click', () => selectFrame(index));
      cells.appendChild(cell);
    }

    viewer.append(row, bar, status, cells);
    view.appendChild(viewer);
    // Sized once mounted; the frame's own size may not be known yet, so
    // `applySheetSize` also listens for the load.
    const fit = (): void => applySheetSize(sheet, board, sheetEl, img, zoom.label);
    fit();
    // The board only knows its room once it is in the stage, and the view is built
    // detached, so the fitted size is settled on the next frame.
    requestAnimationFrame(fit);
    // A resize changes that room, and the fit is the only size that reads it. The
    // listener outlives this render, so it drops itself once the frame is gone.
    refitOnResize(sheet, img, fit);
    return view;
  }

  function selectFrame(index: number): void {
    state.draftFrame = index;
    deps.renderStage();
    deps.renderContext();
    deps.renderInspector();
  }

  function stepFrame(delta: number): void {
    const frameCount = state.draftDescriptor?.frameCount ?? 0;
    if (frameCount === 0) {
      return;
    }
    state.draftFrame = Math.max(0, Math.min(frameCount - 1, state.draftFrame + delta));
    deps.renderStage();
    deps.renderContext();
    deps.renderInspector();
  }

  // --- exits ----------------------------------------------------------------

  function commitSection(): HTMLElement {
    const section = make('section', 'inspector-section');
    section.dataset.inspectorSection = 'commit';
    section.appendChild(make('h3', 'ttl sub', 'Commit'));

    const target = state.target.kind === 'draft' ? state.target : null;
    if (!target) {
      section.appendChild(make('p', 'muted', 'Commit turns this Draft into an immutable Clip.'));
      return section;
    }

    const nameInput = document.createElement('input');
    nameInput.dataset.commitName = '';
    // A Draft is often derived from the Clip it replaces, so the obvious name is
    // already taken; offering the first free one saves a rejected commit.
    nameInput.value = freeClipId(target.characterId, target.draftId);
    const button = make('button', 'btn small', 'Commit as Clip') as HTMLButtonElement;
    button.dataset.commitRun = '';
    const message = make('p', 'muted');
    message.dataset.commitMessage = '';

    button.addEventListener('click', () => {
      deps.run('Commit', () => commit(nameInput.value.trim(), message));
    });

    section.append(labeled('Clip name', nameInput), button, message);
    return section;
  }

  /** The first id of the `base`, `base-2`, `base-3`, … series not already taken. */
  function freeClipId(characterId: string, base: string): string {
    const taken = new Set(
      state.scan?.characters
        .find((candidate) => candidate.id === characterId)
        ?.assets.map((asset) => asset.id) ?? [],
    );
    if (!taken.has(base)) {
      return base;
    }
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
    return base;
  }

  async function commit(name: string, message: HTMLElement): Promise<void> {
    const target = state.target.kind === 'draft' ? state.target : null;
    if (!target) {
      return;
    }
    if (!name) {
      message.textContent = 'a Clip name is required';
      return;
    }
    try {
      const committed = await api.commitDraft(target.characterId, target.draftId, name);
      // Committing consumes the Draft, so the open target has to move: the new Clip
      // is shown on its own face, where it plays back like any committed Asset.
      state.draftDescriptor = null;
      state.repair = null;
      await deps.rescan();
      await deps.loadAsset(target.characterId, 'clip', committed.id);
    } catch (error) {
      message.textContent = (error as Error).message;
    }
  }

  function discardSection(): HTMLElement {
    const section = make('section', 'inspector-section');
    section.dataset.inspectorSection = 'discard';
    section.appendChild(make('h3', 'ttl sub', 'Discard'));

    const target = state.target.kind === 'draft' ? state.target : null;
    if (!target) {
      return section;
    }
    section.appendChild(
      make('p', 'muted', 'Deletes the Draft frames and the Repair script it owns.'),
    );
    const button = make('button', 'btn small ghost', 'Discard draft') as HTMLButtonElement;
    button.dataset.discardDraft = '';
    button.addEventListener('click', () => {
      deps.run('Discard draft', async () => {
        if (!(await confirmAction(`Discard draft "${target.draftId}"?`, 'Discard'))) {
          return;
        }
        await discard(target.characterId, target.draftId);
      });
    });
    section.appendChild(button);
    return section;
  }

  async function discard(characterId: string, draftId: string): Promise<void> {
    await api.discardDraft(characterId, draftId);
    // The target was the Draft, which no longer exists: fall back to its Character.
    state.target = { kind: 'character', characterId };
    state.draftDescriptor = null;
    state.repair = null;
    await deps.rescan();
    deps.setMode('align');
    await deps.loadAlignment(characterId);
  }

  return { renderView, repairBar, repairLog, commitSection, discardSection };
}
