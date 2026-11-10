/**
 * The Clip-editor stage: a **Draft**'s frames plus painting, or a committed
 * **Asset**'s playback.
 *
 * A Recording is not here — cutting is its own face (see `stageCut.ts`), because a
 * Segment means nothing while repairing. Extract is the join: it leaves the cut
 * face for the Draft it produced, so the two faces hand over rather than overlap.
 */

import type { WorkbenchContext } from './context.js';
import { confirmAction, promptText } from './dialog.js';
import { addRow, labeled, make } from './dom.js';
import { attachPainting, repairBar } from './repair.js';
import { activeAsset, activeDraft } from './state.js';

/** Render the clip face for whatever is open. */
export function clipStageView(ctx: WorkbenchContext): HTMLElement {
  const view = make('div', 'stage-view');
  view.dataset.stageView = 'clip-editor';

  if (ctx.state.target.kind === 'draft') {
    draftView(ctx, view);
    return view;
  }
  if (ctx.state.target.kind === 'asset') {
    assetView(ctx, view);
    return view;
  }
  view.dataset.emptyState = 'clip-editor';
  view.appendChild(
    make('p', 'muted', 'Clip editor — pick a Draft in the Library to repair it.'),
  );
  return view;
}

// --- Committed Asset face: playback, and Sequence composition ----------------

/**
 * A committed Asset is immutable, so this face only plays it back. A Sequence
 * additionally carries its **composition** — the ordered source Clips — which is
 * the one thing about a Sequence that is edited rather than re-baked.
 */
function assetView(ctx: WorkbenchContext, view: HTMLElement): void {
  const asset = ctx.state.asset;
  const target = activeAsset(ctx.state);
  if (!asset || !target) {
    view.appendChild(make('p', 'muted', 'Select an asset in the Library to view it.'));
    return;
  }

  view.appendChild(playback(ctx, target.characterId, target.assetKind, target.assetId, asset.meta));
  if (target.assetKind === 'sequence') {
    view.appendChild(sequencePanel(ctx, target.characterId, target.assetId));
  }
}

/** Play a baked sheet by stepping its own `delaysMs`, looping when it loops. */
function playback(
  ctx: WorkbenchContext,
  characterId: string,
  kind: 'clip' | 'sequence',
  assetId: string,
  meta: { frameCount: number },
): HTMLElement {
  const wrap = make('div', 'recording-viewer');
  wrap.dataset.assetViewer = '';
  wrap.dataset.assetFrameCount = String(meta.frameCount);

  const box = make('div', 'sheet-box');
  const img = document.createElement('img');
  img.className = 'sheet';
  img.dataset.assetFrame = String(ctx.state.assetFrame);
  img.src = ctx.api.sheetUrl(characterId, kind, assetId);
  img.alt = `baked sheet, frame ${ctx.state.assetFrame}`;
  // The sheet is one strip; the frame is a crop. Sizing the strip to
  // `frameCount × 100%` and sliding it left by one frame keeps the aspect ratio
  // and needs no request per frame.
  img.style.width = `${meta.frameCount * 100}%`;
  img.style.transform = `translateX(${(-ctx.state.assetFrame * 100) / meta.frameCount}%)`;
  box.appendChild(img);

  const counter = make('span', 'pill');
  counter.dataset.assetFrameCounter = '';
  counter.textContent = `frame ${ctx.state.assetFrame} / ${meta.frameCount}`;

  const prev = make('button', 'btn ghost', '◀') as HTMLButtonElement;
  prev.disabled = ctx.state.assetFrame <= 0;
  prev.addEventListener('click', () => stepAssetFrame(ctx, -1));

  const next = make('button', 'btn ghost', '▶') as HTMLButtonElement;
  next.disabled = ctx.state.assetFrame >= meta.frameCount - 1;
  next.addEventListener('click', () => stepAssetFrame(ctx, 1));

  const row = make('div', 'draft-stage');
  row.append(prev, box, next);
  wrap.append(row, counter);
  return wrap;
}

function stepAssetFrame(ctx: WorkbenchContext, delta: number): void {
  const frameCount = ctx.state.asset?.meta.frameCount ?? 0;
  if (frameCount === 0) {
    return;
  }
  ctx.state.assetFrame = Math.max(0, Math.min(frameCount - 1, ctx.state.assetFrame + delta));
  ctx.renderStage();
  ctx.renderContext();
  ctx.renderInspector();
}

/** The Sequence's ordered source Clips, editable in place, plus re-commit. */
function sequencePanel(
  ctx: WorkbenchContext,
  characterId: string,
  sequenceId: string,
): HTMLElement {
  const panel = make('section', 'segments');
  panel.dataset.sequencePanel = '';
  panel.appendChild(make('h3', 'ttl sub', 'Composition'));

  const draft = ctx.state.sequenceDraft;
  if (!draft) {
    const start = make('button', 'btn small', 'Edit composition') as HTMLButtonElement;
    start.dataset.sequenceEdit = '';
    start.addEventListener('click', () => {
      void ctx.run('Edit composition', () => startComposition(ctx, characterId, sequenceId));
    });
    panel.append(
      make('p', 'muted', 'Editing a Sequence copies its Clip list into a new composition.'),
      start,
    );
    return panel;
  }

  const name = document.createElement('input');
  name.dataset.sequenceName = '';
  name.value = draft.name;
  name.addEventListener('change', () => {
    if (ctx.state.sequenceDraft) {
      ctx.state.sequenceDraft.name = name.value.trim();
    }
  });

  const list = make('ol', 'sequence-list');
  list.dataset.sequenceList = '';
  if (draft.clips.length === 0) {
    list.appendChild(make('li', 'muted', 'No Clips yet — add one below.'));
  }
  draft.clips.forEach((clipId, index) => {
    const item = make('li', 'sequence-item');
    item.dataset.sequenceClip = clipId;
    item.dataset.sequenceIndex = String(index);
    item.appendChild(make('span', 'sequence-clip', clipId));

    const up = make('button', 'btn small ghost', '↑') as HTMLButtonElement;
    up.dataset.sequenceUp = '';
    up.disabled = index === 0;
    up.addEventListener('click', () => moveClip(ctx, index, -1));

    const down = make('button', 'btn small ghost', '↓') as HTMLButtonElement;
    down.disabled = index === draft.clips.length - 1;
    down.addEventListener('click', () => moveClip(ctx, index, 1));

    const remove = make('button', 'btn small ghost', 'Remove') as HTMLButtonElement;
    remove.dataset.sequenceRemove = '';
    remove.addEventListener('click', () => {
      ctx.state.sequenceDraft?.clips.splice(index, 1);
      ctx.renderStage();
      ctx.renderInspector();
    });

    item.append(up, down, remove);
    list.appendChild(item);
  });

  const addRow = make('label', 'field');
  addRow.append(make('span', 'k', 'add clip'));
  const addSelect = document.createElement('select');
  addSelect.dataset.sequenceAdd = '';
  for (const clip of ctx.state.scan?.characters
    .find((candidate) => candidate.id === characterId)
    ?.assets.filter((asset) => asset.kind === 'clip') ?? []) {
    const option = document.createElement('option');
    option.value = clip.id;
    option.textContent = clip.id;
    addSelect.appendChild(option);
  }
  addRow.appendChild(addSelect);

  const add = make('button', 'btn small', 'Add') as HTMLButtonElement;
  add.dataset.sequenceAddRun = '';
  add.addEventListener('click', () => {
    if (addSelect.value) {
      ctx.state.sequenceDraft?.clips.push(addSelect.value);
      ctx.renderStage();
      ctx.renderInspector();
    }
  });

  const commitRow = make('div', 'commit-row');
  const commit = make('button', 'btn small', 'Commit sequence') as HTMLButtonElement;
  commit.dataset.sequenceCommit = '';
  commit.addEventListener('click', () => {
    void ctx.run('Commit sequence', () => commitSequence(ctx, characterId));
  });
  const cancel = make('button', 'btn small ghost', 'Cancel') as HTMLButtonElement;
  cancel.addEventListener('click', () => {
    ctx.state.sequenceDraft = null;
    ctx.renderStage();
    ctx.renderInspector();
  });
  commitRow.append(commit, cancel);

  panel.append(labeled('sequence name', name), list, addRow, add, commitRow);
  return panel;
}

function moveClip(ctx: WorkbenchContext, index: number, delta: number): void {
  const clips = ctx.state.sequenceDraft?.clips;
  const swap = index + delta;
  if (!clips || swap < 0 || swap >= clips.length) {
    return;
  }
  [clips[index], clips[swap]] = [clips[swap] as string, clips[index] as string];
  ctx.renderStage();
  ctx.renderInspector();
}

/** Fork a Sequence's Clip list into a fresh composition, or resume one already open. */
async function startComposition(
  ctx: WorkbenchContext,
  characterId: string,
  sequenceId: string,
): Promise<void> {
  const fork = await ctx.api.forkSequence(characterId, sequenceId);
  ctx.state.sequenceDraft = { name: sequenceId, clips: [...fork.clips], forkOf: sequenceId };
  ctx.renderStage();
  ctx.renderInspector();
}

async function commitSequence(ctx: WorkbenchContext, characterId: string): Promise<void> {
  const draft = ctx.state.sequenceDraft;
  if (!draft) {
    return;
  }
  if (draft.clips.length === 0) {
    throw new Error('a Sequence needs at least one Clip');
  }
  const committed = await ctx.api.commitSequence(characterId, draft.name, draft.clips);
  ctx.state.sequenceDraft = null;
  // Committing a Sequence is additive: a Sequence of the same id can exist once,
  // so land on the Asset that was just written.
  await ctx.loadAsset(characterId, 'sequence', committed.id);
  await ctx.rescan();
}

// --- Draft face: the frames, and painting ------------------------------------

function draftView(ctx: WorkbenchContext, view: HTMLElement): void {
  const draft = ctx.state.draftDescriptor;
  const target = activeDraft(ctx.state);
  if (!draft || !target) {
    view.appendChild(make('p', 'muted', 'Select a Draft in the Library to view its frames.'));
    return;
  }

  const viewer = make('div', 'draft-viewer');
  viewer.dataset.draftViewer = '';
  viewer.dataset.character = target.characterId;
  viewer.dataset.draft = target.draftId;
  viewer.dataset.activeFrame = String(ctx.state.draftFrame);

  const prev = make('button', 'btn ghost', '◀') as HTMLButtonElement;
  prev.dataset.frameStep = 'prev';
  prev.disabled = ctx.state.draftFrame <= 0;
  prev.addEventListener('click', () => stepDraftFrame(ctx, -1));

  const img = document.createElement('img');
  img.className = 'draft-frame';
  img.dataset.draftFrame = '';
  img.dataset.frameIndex = String(ctx.state.draftFrame);
  img.src = ctx.api.frameUrl(
    target.characterId,
    target.draftId,
    ctx.state.draftFrame,
    ctx.state.repairRevision,
  );
  img.alt = `${target.draftId} frame ${ctx.state.draftFrame}`;
  attachPainting(ctx, img);

  const next = make('button', 'btn ghost', '▶') as HTMLButtonElement;
  next.dataset.frameStep = 'next';
  next.disabled = ctx.state.draftFrame >= draft.frameCount - 1;
  next.addEventListener('click', () => stepDraftFrame(ctx, 1));

  const counter = make('span', 'pill');
  counter.dataset.draftFrameCounter = '';
  counter.textContent = `frame ${ctx.state.draftFrame} / ${draft.frameCount}`;

  const row = make('div', 'draft-stage');
  row.append(prev, img, next);
  // The tools hang under the frame they paint on; the inspector keeps the log.
  const bar = repairBar(ctx);

  const cells = make('div', 'draft-frames');
  cells.setAttribute('role', 'list');
  for (let index = 0; index < draft.frameCount; index += 1) {
    const cell = make('button', 'cell');
    cell.dataset.draftFrameCell = String(index);
    cell.setAttribute('role', 'listitem');
    cell.title = `frame ${index}`;
    cell.textContent = String(index);
    cell.classList.toggle('sel', index === ctx.state.draftFrame);
    cell.addEventListener('click', () => selectDraftFrame(ctx, index));
    cells.appendChild(cell);
  }

  viewer.append(row, bar, counter, cells);
  view.appendChild(viewer);
}

function selectDraftFrame(ctx: WorkbenchContext, index: number): void {
  ctx.state.draftFrame = index;
  ctx.renderStage();
  ctx.renderContext();
  ctx.renderInspector();
}

function stepDraftFrame(ctx: WorkbenchContext, delta: number): void {
  const frameCount = ctx.state.draftDescriptor?.frameCount ?? 0;
  if (frameCount === 0) {
    return;
  }
  ctx.state.draftFrame = Math.max(0, Math.min(frameCount - 1, ctx.state.draftFrame + delta));
  ctx.renderStage();
  ctx.renderContext();
  ctx.renderInspector();
}
