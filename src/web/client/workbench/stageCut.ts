/**
 * The Cutting face: a Recording's frames, and the Segments cut from them.
 *
 * This is its own face because a Segment only exists inside a Recording — an
 * unrelated idea while repairing a Draft. Keeping the filmstrip here too means
 * the pick track and the existing bands are the only things to drag, so
 * "mark a new range" and "move an existing edge" can never be confused.
 *
 * The stage shows the frame; the filmstrip below picks the range; the inspector
 * edits the selected Segment. Extract leaves this face for the Draft it produced.
 */

import type { WorkbenchContext } from './context.js';
import { confirmAction, chooseAction, promptText } from './dialog.js';
import { make } from './dom.js';
import { stopPlayback } from './filmstrip.js';
import type { Segment } from '../types.js';

/** Render the cut face for the loaded Recording. */
export function cutStageView(ctx: WorkbenchContext): HTMLElement {
  const view = make('div', 'stage-view');
  view.dataset.stageView = 'cut';

  const recordingId = ctx.state.recordingId;
  const cutList = ctx.state.cutList;
  if (ctx.state.target.kind !== 'recording' || !recordingId || !cutList) {
    view.dataset.emptyState = 'cut';
    view.appendChild(
      make('p', 'muted', 'Open a Recording from the Library to cut it into Segments.'),
    );
    return view;
  }

  const preview = make('div', 'recording-viewer');
  preview.dataset.recordingViewer = '';
  preview.dataset.recording = recordingId;
  preview.dataset.activeFrame = String(ctx.state.frame);

  const prev = make('button', 'btn ghost', '◀') as HTMLButtonElement;
  prev.dataset.frameStep = 'prev';
  prev.disabled = ctx.state.frame <= 0;
  prev.addEventListener('click', () => stepFrame(ctx, -1));

  const img = document.createElement('img');
  img.className = 'recording-frame';
  img.dataset.recordingFrame = '';
  img.dataset.frameIndex = String(ctx.state.frame);
  img.src = ctx.api.recordingFrameUrl(recordingId, ctx.state.frame);
  img.alt = `${recordingId} frame ${ctx.state.frame}`;

  const next = make('button', 'btn ghost', '▶') as HTMLButtonElement;
  next.dataset.frameStep = 'next';
  next.disabled = ctx.state.frame >= cutList.frameCount - 1;
  next.addEventListener('click', () => stepFrame(ctx, 1));

  const counter = make('span', 'pill');
  counter.dataset.recordingFrameCounter = '';
  counter.textContent = `frame ${ctx.state.frame} / ${cutList.frameCount}`;

  const row = make('div', 'draft-stage');
  row.append(prev, img, next);
  preview.append(row, counter);
  view.appendChild(preview);
  return view;
}

function stepFrame(ctx: WorkbenchContext, delta: number): void {
  const frameCount = ctx.state.cutList?.frameCount ?? 0;
  if (frameCount === 0) {
    return;
  }
  // Stepping by hand is a scrub, so it takes over from playback.
  stopPlayback(ctx.state);
  ctx.state.frame = Math.max(0, Math.min(frameCount - 1, ctx.state.frame + delta));
  ctx.renderStage();
  ctx.renderFilmstrip();
  ctx.renderContext();
  ctx.renderInspector();
}

/**
 * The Segment editor, hosted by the Recording inspector rather than the stage.
 *
 * The rail is the Segment *picker* (its rows select) and the filmstrip shows the
 * ranges as bands; this panel edits whichever one is selected. The stage stays
 * pixels only, and the `extract into` target sits once at the top because it is a
 * property of the Recording, not of any one cut — so it survives a change of
 * selection.
 */
export function segmentEditor(ctx: WorkbenchContext, recordingId: string): HTMLElement {
  const panel = make('section', 'segment-editor');
  panel.dataset.segmentEditor = '';

  // The target is a Character. With nothing chosen it stays unchosen and Extract
  // asks, so no Character is picked on the user's behalf.
  const characters = ctx.state.scan?.characters ?? [];
  const targetId = ctx.state.extractCharacterId;

  const extractRow = make('label', 'field');
  extractRow.append(make('span', 'k', 'extract into'));
  const characterSelect = document.createElement('select');
  characterSelect.dataset.extractCharacter = '';
  {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '— choose on extract —';
    option.selected = targetId === null;
    characterSelect.appendChild(option);
  }
  for (const character of characters) {
    const option = document.createElement('option');
    option.value = character.id;
    option.textContent = character.id;
    option.selected = character.id === targetId;
    characterSelect.appendChild(option);
  }
  characterSelect.addEventListener('change', () => {
    ctx.state.extractCharacterId = characterSelect.value || null;
    // Re-render so the Extract buttons relabel to match the choice.
    ctx.renderStage();
  });
  extractRow.appendChild(characterSelect);
  panel.appendChild(extractRow);

  const selected = (ctx.state.cutList?.cuts ?? []).find(
    (segment) => segment.id === ctx.state.selectedCut,
  );
  if (!selected) {
    panel.appendChild(
      make(
        'p',
        'rail-hint',
        'Pick a Segment in the Library, or a band on the strip, to edit it.',
      ),
    );
    return panel;
  }

  const detail = make('div', 'segment-detail');
  detail.dataset.segmentDetail = selected.id;
  detail.appendChild(
    make(
      'p',
      'muted',
      `"${selected.id}" frames ${selected.startFrame}–${selected.endFrame - 1}` +
        `${selected.speed ? ` at ${selected.speed}×` : ''}`,
    ),
  );

  // Without a target the button *is* the way to get one: extracting asks which
  // Character (or a new id), creates it framed from this Segment, then extracts.
  const extract = make(
    'button',
    'btn small',
    targetId !== null
      ? 'Extract'
      : characters.length > 0
        ? 'Extract → Choose Character…'
        : 'Extract → New Character…',
  ) as HTMLButtonElement;
  extract.dataset.segmentExtract = selected.id;
  extract.addEventListener('click', () => {
    void ctx.run('Extract segment', () => extractSegment(ctx, recordingId, selected.id));
  });

  const rename = make('button', 'btn small ghost', 'Rename') as HTMLButtonElement;
  rename.dataset.segmentRename = selected.id;
  rename.addEventListener('click', () => {
    void ctx.run('Rename segment', () => renameSegment(ctx, recordingId, selected.id));
  });

  const remove = make('button', 'btn small ghost', 'Delete') as HTMLButtonElement;
  remove.dataset.segmentDelete = selected.id;
  remove.addEventListener('click', () => {
    void ctx.run('Delete segment', async () => {
      // Deleting a Segment is not undoable, so it asks first.
      if (!(await confirmAction(`Delete segment "${selected.id}"?`, 'Delete'))) {
        return;
      }
      await removeSegment(ctx, recordingId, selected.id);
    });
  });

  const actions = make('div', 'asset-actions');
  actions.append(extract, rename, remove);
  detail.appendChild(actions);
  panel.appendChild(detail);
  return panel;
}

/**
 * Select a Segment, from the rail row or a band in the filmstrip.
 *
 * Selection is not a load: the Recording stays on screen, only the marks and the
 * inspector's detail change. It takes the playhead into the range so Play previews
 * the thing you just picked.
 */
export function selectSegment(ctx: WorkbenchContext, segment: Segment): void {
  stopPlayback(ctx.state);
  ctx.state.selectedCut = segment.id;
  ctx.state.frame = segment.startFrame;
  paintSegmentMarks(ctx);
  ctx.renderStage();
  ctx.renderFilmstrip();
  ctx.renderContext();
  ctx.renderInspector();
}

/** Re-mark the selected Segment in the rail, without rebuilding the rail. */
export function paintSegmentMarks(ctx: WorkbenchContext): void {
  for (const row of ctx.regions.rail.querySelectorAll<HTMLElement>('[data-segment]')) {
    row.classList.toggle('sel', row.dataset.segment === ctx.state.selectedCut);
  }
}

/**
 * Save the range marked on the filmstrip as a Segment.
 *
 * The range is already confirmed — it was played — so only a name is missing;
 * with one, the Segment is written and left selected for Extract. The marks are
 * cleared either way, since they have become something stored.
 */
export async function saveSelectionAsSegment(ctx: WorkbenchContext): Promise<void> {
  const { state, api } = ctx;
  const recordingId = state.recordingId;
  const selection = state.selection;
  if (recordingId === null || !selection) {
    return;
  }
  const suggested = `cut-${(state.cutList?.cuts.length ?? 0) + 1}`;
  const id = (
    await promptText(
      `Name the Segment for frames ${selection.startFrame}–${selection.endFrame - 1}:`,
      suggested,
      'Save Segment',
    )
  )?.trim();
  if (!id) {
    return;
  }

  state.cutList = await api.addSegment(recordingId, {
    id,
    startFrame: selection.startFrame,
    endFrame: selection.endFrame,
  });
  state.selection = null;
  state.selectedCut = id;
  state.frame = selection.startFrame;
  ctx.renderLibrary();
  ctx.renderStage();
  ctx.renderFilmstrip();
  ctx.renderContext();
  ctx.renderInspector();
}

async function renameSegment(
  ctx: WorkbenchContext,
  recordingId: string,
  cutId: string,
): Promise<void> {
  const next = await promptText(`Rename segment "${cutId}" to:`, cutId, 'Rename');
  if (next === null || next === '' || next === cutId) {
    return;
  }
  ctx.state.cutList = await ctx.api.renameSegment(recordingId, cutId, next);
  // Follow the cut to its new id, so the inspector keeps editing the same one.
  if (ctx.state.selectedCut === cutId) {
    ctx.state.selectedCut = next;
  }
  ctx.renderLibrary();
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
  if (ctx.state.selectedCut === cutId) {
    ctx.state.selectedCut = null;
  }
  ctx.renderLibrary();
  ctx.renderStage();
  ctx.renderFilmstrip();
  ctx.renderInspector();
}

async function extractSegment(
  ctx: WorkbenchContext,
  recordingId: string,
  cutId: string,
): Promise<void> {
  const characterId = await resolveExtractTarget(ctx, recordingId, cutId);
  if (characterId === null) {
    return;
  }
  const draft = await extractClipDraftInto(ctx, characterId, recordingId, cutId);
  if (draft === null) {
    return;
  }
  await ctx.rescan();
  await ctx.loadDraft(characterId, draft.id);
}

/**
 * The Character to extract into, creating one when asked for.
 *
 * The Segment's own frames frame the new Character, so a first-time user can go
 * straight from a cut to a Draft without visiting another screen. Nothing is
 * inferred: with no target chosen, the Character is asked for — a pick among the
 * ones that exist, or a new id — and the pick then sticks for the Recording.
 */
async function resolveExtractTarget(
  ctx: WorkbenchContext,
  recordingId: string,
  cutId: string,
): Promise<string | null> {
  if (ctx.state.extractCharacterId !== null) {
    return ctx.state.extractCharacterId;
  }

  const characters = ctx.state.scan?.characters ?? [];
  if (characters.length > 0) {
    const NEW = ' new';
    const picked = await chooseAction(
      'Extract this Segment into which Character?',
      [
        ...characters.map((character) => ({
          value: character.id,
          label: character.id,
          note: `${character.drafts.length} draft(s) · ${character.assets.length} asset(s)`,
        })),
        { value: NEW, label: 'New Character…', note: 'named next, framed from this Segment' },
      ],
      'Extract',
    );
    if (picked === null) {
      return null;
    }
    if (picked !== NEW) {
      ctx.state.extractCharacterId = picked;
      return picked;
    }
  }

  const id = (await promptText('New Character id to extract into:', '', 'Create'))?.trim();
  if (!id) {
    return null;
  }
  const derived = await ctx.api.deriveAnchor(recordingId, cutId);
  await ctx.api.createCharacter(id, {
    width: derived.canvas.width,
    height: derived.canvas.height,
    anchorX: derived.canvas.anchor.x,
    anchorY: derived.canvas.anchor.y,
  });
  ctx.state.extractCharacterId = id;
  ctx.state.activeCharacterId = id;
  return id;
}

/**
 * Extract, offering the explicit Canvas expand the store demands when the Segment
 * is bigger than the Character's Canvas.
 *
 * Extraction is a hard error on overflow rather than a silent grow (ADR-0006), so
 * the refusal is caught and turned into the offer instead of an action-error text.
 */
async function extractClipDraftInto(
  ctx: WorkbenchContext,
  characterId: string,
  recordingId: string,
  cutId: string,
): Promise<{ id: string } | null> {
  try {
    return await ctx.api.extractClipDraft(characterId, { recordingId, cutId });
  } catch (error) {
    const message = (error as Error).message;
    if (!/canvas/i.test(message)) {
      throw error;
    }
    const derived = await ctx.api.deriveAnchor(recordingId, cutId);
    const canvas = ctx.state.alignment?.canvas;
    const offered = await confirmAction(
      `${message}\n\nExpand "${characterId}" to ${derived.canvas.width}×${derived.canvas.height}` +
        `${canvas ? ` (from ${canvas.width}×${canvas.height})` : ''} and extract?`,
      'Expand and extract',
    );
    if (!offered) {
      return null;
    }
    await ctx.api.expandCanvas(characterId, derived.canvas.width, derived.canvas.height);
    return await ctx.api.extractClipDraft(characterId, { recordingId, cutId });
  }
}

/**
 * Open a Recording **for this Character**: the way footage enters a Character.
 *
 * Opening points Extract at it, so cutting a Segment can follow immediately
 * without re-picking the target each time.
 */
export function recordingPicker(ctx: WorkbenchContext, characterId: string): HTMLElement {
  const recordings = ctx.state.scan?.recordings ?? [];
  const form = make('form', 'segment-add');
  form.dataset.characterRecordingForm = characterId;

  if (recordings.length === 0) {
    form.appendChild(make('p', 'rail-hint', 'No Recordings yet.'));
    const importButton = make('button', 'btn small', 'Import a Recording') as HTMLButtonElement;
    importButton.type = 'button';
    importButton.dataset.characterRecordingImport = '';
    importButton.addEventListener('click', () => {
      ctx.state.railForm = 'import';
      ctx.renderLibrary();
    });
    form.appendChild(importButton);
    return form;
  }

  const select = document.createElement('select');
  select.dataset.characterRecording = '';
  for (const recording of recordings) {
    const option = document.createElement('option');
    option.value = recording.id;
    option.textContent = recording.id;
    option.selected = recording.id === ctx.state.recordingId;
    select.appendChild(option);
  }

  const button = make('button', 'btn small', 'Open Recording') as HTMLButtonElement;
  button.type = 'submit';
  button.dataset.characterRecordingOpen = '';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // Extract is aimed at this Character for as long as its work is open.
    ctx.state.extractCharacterId = characterId;
    void ctx.loadRecording(select.value);
  });

  form.append(select, button);
  return form;
}


