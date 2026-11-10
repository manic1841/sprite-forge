/**
 * The Clip-editor stage, and the one workspace the whole job lives in.
 *
 * Two things can be open here: a **Recording** (preview, scrub, segments) and a
 * **Draft** (frames plus painting). The target, not the mode, decides which — so
 * cutting a Recording and repairing a Draft never needs a different screen, and
 * extracting a Segment drops you straight onto the Draft it produced.
 */

import type { WorkbenchContext } from './context.js';
import { labeled, make, numberInput } from './dom.js';
import { attachPainting } from './repair.js';
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
  if (ctx.state.target.kind === 'recording') {
    recordingView(ctx, view);
    return view;
  }
  view.dataset.emptyState = 'clip-editor';
  view.appendChild(
    make(
      'p',
      'muted',
      'Clip editor — pick a Recording in the Library to cut it, or a Draft to repair it.',
    ),
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

// --- Recording face: preview, scrub, segments --------------------------------

function recordingView(ctx: WorkbenchContext, view: HTMLElement): void {
  const { state } = ctx;
  const recordingId = state.recordingId;
  const cutList = state.cutList;
  if (!recordingId || !cutList) {
    view.appendChild(make('p', 'muted', 'Load a Recording to preview it.'));
    return;
  }

  const preview = make('div', 'recording-viewer');
  preview.dataset.recordingViewer = '';
  preview.dataset.recording = recordingId;
  preview.dataset.activeFrame = String(state.frame);

  const prev = make('button', 'btn ghost', '◀') as HTMLButtonElement;
  prev.dataset.frameStep = 'prev';
  prev.disabled = state.frame <= 0;
  prev.addEventListener('click', () => stepFrame(ctx, -1));

  const img = document.createElement('img');
  img.className = 'recording-frame';
  img.dataset.recordingFrame = '';
  img.dataset.frameIndex = String(state.frame);
  img.src = ctx.api.recordingFrameUrl(recordingId, state.frame);
  img.alt = `${recordingId} frame ${state.frame}`;

  const next = make('button', 'btn ghost', '▶') as HTMLButtonElement;
  next.dataset.frameStep = 'next';
  next.disabled = state.frame >= cutList.frameCount - 1;
  next.addEventListener('click', () => stepFrame(ctx, 1));

  const counter = make('span', 'pill');
  counter.dataset.recordingFrameCounter = '';
  counter.textContent = `frame ${state.frame} / ${cutList.frameCount}`;

  const row = make('div', 'draft-stage');
  row.append(prev, img, next);
  preview.append(row, counter);
  view.appendChild(preview);

  view.appendChild(segmentPanel(ctx, recordingId));
}

function stepFrame(ctx: WorkbenchContext, delta: number): void {
  const frameCount = ctx.state.cutList?.frameCount ?? 0;
  if (frameCount === 0) {
    return;
  }
  ctx.state.frame = Math.max(0, Math.min(frameCount - 1, ctx.state.frame + delta));
  ctx.renderStage();
  ctx.renderFilmstrip();
  ctx.renderContext();
  ctx.renderInspector();
}

/** The segment list: rename, re-cut by hand, extract to a Draft, or delete. */
function segmentPanel(ctx: WorkbenchContext, recordingId: string): HTMLElement {
  const panel = make('section', 'segments');
  panel.dataset.segmentPanel = '';
  panel.appendChild(make('h3', 'ttl sub', 'Segments'));

  const characters = ctx.state.scan?.characters ?? [];
  const extractRow = make('label', 'field');
  extractRow.append(make('span', 'k', 'extract into'));
  const characterSelect = document.createElement('select');
  characterSelect.dataset.extractCharacter = '';
  // Default to the Character already in play, so a re-render does not silently
  // retarget the Extract button at whichever Character sorts first.
  const preferred = ctx.state.activeCharacterId ?? characters[0]?.id;
  for (const character of characters) {
    const option = document.createElement('option');
    option.value = character.id;
    option.textContent = character.id;
    option.selected = character.id === preferred;
    characterSelect.appendChild(option);
  }
  extractRow.appendChild(characterSelect);
  panel.appendChild(extractRow);

  const list = make('ul', 'segment-list');
  list.dataset.segmentList = '';
  for (const segment of ctx.state.cutList?.cuts ?? []) {
    const item = make('li', 'segment');
    item.dataset.segment = segment.id;
    item.append(
      make('span', 'asset-name', segment.id),
      make('span', 'asset-sub', `[${segment.startFrame}, ${segment.endFrame})`),
    );

    const extract = make('button', 'btn small', 'Extract') as HTMLButtonElement;
    extract.dataset.segmentExtract = segment.id;
    extract.disabled = (characterSelect.value || characters[0]?.id) === undefined;
    extract.addEventListener('click', () => {
      void ctx.run('Extract segment', () =>
        extractSegment(ctx, recordingId, segment.id, characterSelect.value),
      );
    });

    const rename = make('button', 'btn small ghost', 'Rename') as HTMLButtonElement;
    rename.dataset.segmentRename = segment.id;
    rename.addEventListener('click', () => {
      void ctx.run('Rename segment', () => renameSegment(ctx, recordingId, segment.id));
    });

    const remove = make('button', 'btn small ghost', 'Delete') as HTMLButtonElement;
    remove.dataset.segmentDelete = segment.id;
    remove.addEventListener('click', () => {
      // Deleting a Segment is not undoable, so it asks first.
      if (!window.confirm(`Delete segment "${segment.id}"?`)) {
        return;
      }
      void ctx.run('Delete segment', () => removeSegment(ctx, recordingId, segment.id));
    });

    item.append(extract, rename, remove);
    list.appendChild(item);
  }
  if ((ctx.state.cutList?.cuts ?? []).length === 0) {
    list.appendChild(make('li', 'muted', 'No segments yet — add one below.'));
  }
  panel.appendChild(list);

  const addForm = make('form', 'segment-add');
  addForm.dataset.segmentAdd = '';
  const idInput = document.createElement('input');
  idInput.dataset.segmentId = '';
  idInput.placeholder = 'walk';
  const startInput = numberInput(ctx.state.frame, 'start', () => {});
  startInput.dataset.segmentStart = '';
  const endInput = numberInput(
    Math.min(ctx.state.frame + 1, ctx.state.cutList?.frameCount ?? 0),
    'end',
    () => {},
  );
  endInput.dataset.segmentEnd = '';
  const button = make('button', 'btn small', 'Add') as HTMLButtonElement;
  button.type = 'submit';
  button.dataset.segmentAddRun = '';
  const message = make('p', 'muted');
  message.dataset.segmentMessage = '';

  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void ctx.run('Add segment', () =>
      addSegment(ctx, recordingId, idInput, startInput, endInput, message),
    );
  });

  addForm.append(idInput, startInput, endInput, button, message);
  panel.appendChild(addForm);
  panel.appendChild(newCharacterRow(ctx, recordingId));
  return panel;
}

/** Create a Character whose Canvas/Anchor is derived from the current Frame. */
function newCharacterRow(ctx: WorkbenchContext, recordingId: string): HTMLElement {
  const form = make('form', 'character-add');
  form.dataset.characterAdd = '';
  const idInput = document.createElement('input');
  idInput.dataset.characterId = '';
  idInput.placeholder = 'hero';
  const button = make('button', 'btn small', 'New Character') as HTMLButtonElement;
  button.type = 'submit';
  button.dataset.characterAddRun = '';
  const message = make('p', 'muted');
  message.dataset.characterMessage = '';

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void ctx.run('Create Character', () =>
      createCharacter(ctx, recordingId, idInput.value.trim(), message),
    );
  });

  form.append(idInput, button, message);
  return form;
}

async function createCharacter(
  ctx: WorkbenchContext,
  recordingId: string,
  characterId: string,
  message: HTMLElement,
): Promise<void> {
  if (!characterId) {
    message.textContent = 'a character id is required';
    return;
  }
  try {
    // Derive framing from the Segment under the playhead (or the whole Recording at
    // frame 0). A Segment gives a Canvas wide enough for all of its frames, so the
    // Extract that follows cannot be rejected for spilling off the Canvas.
    const cut = (ctx.state.cutList?.cuts ?? []).find(
      (segment) => ctx.state.frame >= segment.startFrame && ctx.state.frame < segment.endFrame,
    );
    const derived = await ctx.api.deriveAnchor(recordingId, cut?.id);
    await ctx.api.createCharacter(characterId, {
      width: derived.canvas.width,
      height: derived.canvas.height,
      anchorX: derived.canvas.anchor.x,
      anchorY: derived.canvas.anchor.y,
    });
    await ctx.rescan();
    ctx.renderStage();
  } catch (error) {
    message.textContent = (error as Error).message;
  }
}

async function addSegment(
  ctx: WorkbenchContext,
  recordingId: string,
  idInput: HTMLInputElement,
  startInput: HTMLInputElement,
  endInput: HTMLInputElement,
  message: HTMLElement,
): Promise<void> {
  const id = idInput.value.trim();
  const startFrame = Number(startInput.value);
  const endFrame = Number(endInput.value);
  if (!id) {
    message.textContent = 'a segment id is required';
    return;
  }
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || endFrame <= startFrame) {
    message.textContent = 'end must be after start';
    return;
  }
  try {
    ctx.state.cutList = await ctx.api.addSegment(recordingId, { id, startFrame, endFrame });
    ctx.renderStage();
    ctx.renderFilmstrip();
    ctx.renderInspector();
  } catch (error) {
    message.textContent = (error as Error).message;
  }
}

async function renameSegment(
  ctx: WorkbenchContext,
  recordingId: string,
  cutId: string,
): Promise<void> {
  const next = window.prompt(`Rename segment "${cutId}" to:`, cutId);
  if (!next || next === cutId) {
    return;
  }
  ctx.state.cutList = await ctx.api.renameSegment(recordingId, cutId, next);
  ctx.renderStage();
  ctx.renderFilmstrip();
  ctx.renderInspector();
}

async function removeSegment(
  ctx: WorkbenchContext,
  recordingId: string,
  cutId: string,
): Promise<void> {
  ctx.state.cutList = await ctx.api.removeSegment(recordingId, cutId);
  ctx.renderStage();
  ctx.renderFilmstrip();
  ctx.renderInspector();
}

async function extractSegment(
  ctx: WorkbenchContext,
  recordingId: string,
  cutId: string,
  characterId: string,
): Promise<void> {
  const draft = await ctx.api.extractClipDraft(characterId, { recordingId, cutId });
  await ctx.rescan();
  await ctx.loadDraft(characterId, draft.id);
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

  viewer.append(row, counter, cells);
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
