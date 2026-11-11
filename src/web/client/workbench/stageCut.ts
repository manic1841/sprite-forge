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
  fitRecordingFrame(ctx, img);

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

/** How far a small frame is blown up on the preview, in screen px per image px. */
const PREVIEW_SCALE_MAX = 16;

/**
 * Grows a small frame to the space there is, up to {@link PREVIEW_SCALE_MAX}.
 *
 * Recording frames are often only a few dozen pixels across, and at their natural
 * size they read as a stamp in the middle of the stage. The rate is a fit with a
 * ceiling and whole numbers, so pixel art stays square.
 */
function fitRecordingFrame(ctx: WorkbenchContext, img: HTMLImageElement): void {
  const size = (): boolean => {
    const width = ctx.regions.stage.clientWidth - 96;
    const height = ctx.regions.stage.clientHeight - 42;
    if (!img.naturalWidth || width <= 0 || height <= 0) {
      return false;
    }
    const fit = Math.min(width / img.naturalWidth, height / img.naturalHeight, PREVIEW_SCALE_MAX);
    const scale = fit >= 1 ? Math.floor(fit) : Math.max(0.25, fit);
    img.style.width = `${img.naturalWidth * scale}px`;
    img.style.height = `${img.naturalHeight * scale}px`;
    return true;
  };
  if (!size()) {
    // Not decoded yet, so there is no natural size to scale from.
    img.addEventListener('load', () => size(), { once: true });
  }
  // The preview follows the stage, and a resize changes it. The listener drops
  // itself once the frame is gone.
  const refit = (): void => {
    if (!img.isConnected) {
      window.removeEventListener('resize', refit);
      return;
    }
    size();
  };
  window.addEventListener('resize', refit);
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
 * pixels only, and the Character a cut is for is settled when it is saved — a
 * property of the Recording rather than of any one cut, so it survives a change
 * of selection without a field standing on the panel.
 */
export function segmentEditor(ctx: WorkbenchContext, recordingId: string): HTMLElement {
  const panel = make('section', 'segment-editor');
  panel.dataset.segmentEditor = '';

  // The target Character is decided when the Segment is saved, so it is not a
  // field here. Only Extract knows it, and it asks when the Segment predates one.
  const targetId = ctx.state.extractCharacterId;

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

  // The head names the cut; renaming is a mark on that name, so it sits next to it.
  // Deleting is about the whole block, so it goes to the far corner where it is out
  // of the reading line but still inside the thing it removes.
  const detail = make('div', 'segment-detail');
  detail.dataset.segmentDetail = selected.id;

  const head = make('div', 'segment-head');
  head.append(make('span', 'segment-name', selected.id));

  const rename = make('button', 'segment-icon', '✎') as HTMLButtonElement;
  rename.type = 'button';
  rename.dataset.segmentRename = selected.id;
  rename.setAttribute('aria-label', `Rename segment "${selected.id}"`);
  rename.title = 'Rename';
  rename.addEventListener('click', () => {
    void ctx.run('Rename segment', () => renameSegment(ctx, recordingId, selected.id));
  });

  const remove = make('button', 'segment-icon is-remove', '✕') as HTMLButtonElement;
  remove.type = 'button';
  remove.dataset.segmentDelete = selected.id;
  remove.setAttribute('aria-label', `Delete segment "${selected.id}"`);
  remove.title = 'Delete';
  remove.addEventListener('click', () => {
    void ctx.run('Delete segment', async () => {
      // Deleting a Segment is not undoable, so it asks first.
      if (!(await confirmAction(`Delete segment "${selected.id}"?`, 'Delete'))) {
        return;
      }
      await removeSegment(ctx, recordingId, selected.id);
    });
  });

  head.append(rename, remove);
  detail.appendChild(head);

  // The range is what the cut *is*, so it reads as the block's own line rather than
  // as part of its name.
  detail.appendChild(
    make(
      'p',
      'segment-frames',
      `frames ${selected.startFrame}–${selected.endFrame - 1}` +
        `${selected.speed ? ` at ${selected.speed}×` : ''}`,
    ),
  );

  // Extract is the one verb that makes something outside this Segment, so it is the
  // block's only solid button, full width, on its own line.
  const extract = make('button', 'btn small segment-extract', 'Extract') as HTMLButtonElement;
  extract.dataset.segmentExtract = selected.id;
  extract.addEventListener('click', () => {
    void ctx.run('Extract segment', () => extractSegment(ctx, recordingId, selected.id));
  });

  detail.appendChild(extract);
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
  // Editing a Segment replaces marking a range: the two never stand at once, so
  // Play has one unambiguous target.
  ctx.state.selection = null;
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
 * The range is already confirmed — it was played — so two things are missing: a
 * name, and the Character the cut belongs to. Both are asked for here, in one
 * pass, because a Segment exists to become footage of a Character and asking at
 * save time is what keeps the question off the panel. The marks are cleared once
 * it is stored.
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

  // The owner is picked among the Characters that exist, or named as a new one. A
  // new Character is framed from this cut, so its id is asked before the cut is
  // written but created after — the framing reads the stored range.
  const target = await askSaveTarget(ctx, id);
  if (target === null) {
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

  if (target.newId === null) {
    state.extractCharacterId = target.characterId;
  } else {
    await createCharacterFramedFrom(ctx, recordingId, id, target.newId);
    await ctx.rescan();
  }

  ctx.renderLibrary();
  ctx.renderStage();
  ctx.renderFilmstrip();
  ctx.renderContext();
  ctx.renderInspector();
}

/** The "new Character" radio's value, in the save and extract asks. */
const NEW_CHARACTER = '\u0000 new';

/** Who a Segment about to be saved is for: an existing Character, or an id to create. */
interface SaveTarget {
  characterId: string | null;
  newId: string | null;
}

/**
 * Ask which Character a Segment belongs to.
 *
 * The first existing Character is preselected so the dialog answers with one
 * Enter, but nothing is decided on the user's behalf — and with no Character in
 * the store, the only branch offered is the new one.
 */
async function askSaveTarget(ctx: WorkbenchContext, cutId: string): Promise<SaveTarget | null> {
  const characters = ctx.state.scan?.characters ?? [];
  if (characters.length > 0) {
    const picked = await chooseAction(
      `Save "${cutId}" for which Character?`,
      [
        ...characters.map((character) => ({
          value: character.id,
          label: character.id,
          note: `${character.drafts.length} draft(s) · ${character.assets.length} asset(s)`,
        })),
        {
          value: NEW_CHARACTER,
          label: 'New Character…',
          note: 'named next, framed from this cut',
          kind: 'create',
        },
      ],
      'Save Segment',
    );
    if (picked === null) {
      return null;
    }
    if (picked !== NEW_CHARACTER) {
      return { characterId: picked, newId: null };
    }
  }

  const newId = (await promptText('New Character id:', '', 'Create'))?.trim();
  return newId ? { characterId: null, newId } : null;
}

/** Create a Character whose Canvas and Anchor are framed from a stored cut. */
async function createCharacterFramedFrom(
  ctx: WorkbenchContext,
  recordingId: string,
  cutId: string,
  characterId: string,
): Promise<string> {
  const derived = await ctx.api.deriveAnchor(recordingId, cutId);
  await ctx.api.createCharacter(characterId, {
    width: derived.canvas.width,
    height: derived.canvas.height,
    anchorX: derived.canvas.anchor.x,
    anchorY: derived.canvas.anchor.y,
  });
  ctx.state.extractCharacterId = characterId;
  ctx.state.activeCharacterId = characterId;
  return characterId;
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
 * The Character to extract into, for a Segment saved before one was chosen.
 *
 * The ask is normally answered at save time, so this is the fallback that keeps an
 * older Segment usable: a pick among the Characters that exist, or a new id framed
 * from this cut. Either answer then sticks for the Recording.
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
    const picked = await chooseAction(
      'Extract this Segment into which Character?',
      [
        ...characters.map((character) => ({
          value: character.id,
          label: character.id,
          note: `${character.drafts.length} draft(s) · ${character.assets.length} asset(s)`,
        })),
        {
          value: NEW_CHARACTER,
          label: 'New Character…',
          note: 'named next, framed from this cut',
          kind: 'create',
        },
      ],
      'Extract',
    );
    if (picked === null) {
      return null;
    }
    if (picked !== NEW_CHARACTER) {
      ctx.state.extractCharacterId = picked;
      return picked;
    }
  }

  const id = (await promptText('New Character id to extract into:', '', 'Create'))?.trim();
  if (!id) {
    return null;
  }
  return await createCharacterFramedFrom(ctx, recordingId, cutId, id);
}

/**
 * Extract, repairing the framing when the Segment does not fit the Canvas.
 *
 * Extraction is a hard error on overflow rather than a silent grow (ADR-0006).
 * The way out depends on whether the Character has been drawn on yet:
 *
 *   - **blank** — its Canvas is only the provisional placeholder, so it is replaced
 *     outright by the framing this Segment implies (`frameCanvas`), which may be
 *     *smaller* than the placeholder. Expand cannot do that: it refuses to shrink.
 *   - **drawn on** — only growing is safe, so the expand is offered at the larger of
 *     the current and derived size on each axis, and needs a confirmation.
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

    // A blank Character is only held back by the placeholder: framing it from this
    // Segment settles the Canvas the Segment was measured against. A drawn-on
    // Character may instead refuse because framing would shrink, which is the case
    // the expand below covers — so a failure here falls through rather than up.
    try {
      await ctx.api.frameCanvas(characterId, { recordingId, cutId });
      return await ctx.api.extractClipDraft(characterId, { recordingId, cutId });
    } catch {
      // Fall through to the expand offer.
    }

    // Drawn on: grow only, and never below what the Canvas already is.
    const derived = await ctx.api.deriveAnchor(recordingId, cutId);
    const canvas = ctx.state.alignment?.canvas ??
      (await ctx.api.readCharacterAlignment(characterId)).canvas;
    const width = Math.max(canvas.width, derived.canvas.width);
    const height = Math.max(canvas.height, derived.canvas.height);
    const offered = await confirmAction(
      `${message}\n\nExpand "${characterId}" to ${width}×${height}` +
        ` (from ${canvas.width}×${canvas.height}) and extract?`,
      'Expand and extract',
    );
    if (!offered) {
      return null;
    }
    await ctx.api.expandCanvas(characterId, width, height);
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


