/**
 * The inspector for a **Character** and for a loaded **Recording**.
 *
 * Both describe source material rather than pixels: a Character is framing (its
 * Canvas is edited on the Alignment face), and a Recording is footage waiting to
 * be cut. The Segment editor and the footage picker live here because they are
 * the two ways a Recording and a Character meet.
 */

import type { RecordingInspectorPort } from './ports.js';
import { addRow, make, subheading } from './dom.js';
import type { Segment } from '../types.js';

// --- Character ---------------------------------------------------------------

/**
 * A Character is framing, not pixels: its facts are the Canvas and what it owns.
 *
 * A new Character is blank and has to be given footage and a Canvas, in that
 * order, so the next step is offered here rather than described — and it stays
 * offered on the Alignment face too, because that is where opening a Character
 * lands.
 */
export function characterInspector(
  ctx: RecordingInspectorPort,
  characterId: string,
  actions: HTMLElement,
  info: HTMLElement,
): void {
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'character';
  section.appendChild(subheading('Character'));

  const character = ctx.state.scan?.characters.find((entry) => entry.id === characterId);
  const list = make('dl', 'kv');
  addRow(list, 'character', characterId);
  addRow(list, 'drafts', String(character?.drafts.length ?? 0));
  addRow(list, 'assets', String(character?.assets.length ?? 0));
  section.appendChild(list);
  section.appendChild(
    make('p', 'muted', 'Its Canvas and Anchor are edited on the Alignment face.'),
  );
  info.appendChild(section);
  actions.appendChild(recordingPicker(ctx, characterId));
}

// --- Recording ---------------------------------------------------------------

/** What the loaded Recording is, and what can be done with its segments. */
export function recordingInspector(
  ctx: RecordingInspectorPort,
  actions: HTMLElement,
  info: HTMLElement,
): void {
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'recording';
  section.appendChild(subheading('Recording'));

  const recordingId = ctx.state.recordingId;
  const cutList = ctx.state.cutList;
  if (!recordingId || !cutList) {
    section.appendChild(
      make('p', 'muted', 'Select a Recording to cut it into segments, then extract one.'),
    );
    info.appendChild(section);
    return;
  }

  const list = make('dl', 'kv');
  addRow(list, 'recording', recordingId);
  addRow(list, 'frames', String(cutList.frameCount));
  addRow(list, 'frame', String(ctx.state.frame));
  addRow(list, 'segments', String(cutList.cuts.length));
  addRow(list, 'hash', cutList.hash.replace(/^sha256:/, '').slice(0, 12));
  section.appendChild(list);
  info.appendChild(section);

  // Marking a range and keeping it are the strip's own gesture and verbs, so the
  // inspector is left with editing a stored Segment.
  const cut = make('section', 'inspector-section');
  cut.dataset.inspectorSection = 'cut';
  cut.appendChild(subheading('Cut'));
  cut.appendChild(segmentEditor(ctx, recordingId));
  actions.appendChild(cut);
}

// --- Segment editor ----------------------------------------------------------

/**
 * The Segment editor, hosted by the Recording inspector rather than the stage.
 *
 * The rail is the Segment *picker* (its rows select) and the filmstrip shows the
 * ranges as bands; this panel edits whichever one is selected. The stage stays
 * pixels only, and the Character a cut is for is settled when it is saved — a
 * property of the Recording rather than of any one cut, so it survives a change
 * of selection without a field standing on the panel.
 */
export function segmentEditor(ctx: RecordingInspectorPort, recordingId: string): HTMLElement {
  const panel = make('section', 'segment-editor');
  panel.dataset.segmentEditor = '';

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
    ctx.run('Rename segment', () => ctx.cut.rename(selected.id));
  });

  const remove = make('button', 'segment-icon is-remove', '✕') as HTMLButtonElement;
  remove.type = 'button';
  remove.dataset.segmentDelete = selected.id;
  remove.setAttribute('aria-label', `Delete segment "${selected.id}"`);
  remove.title = 'Delete';
  remove.addEventListener('click', () => {
    ctx.run('Delete segment', () => ctx.cut.remove(selected.id));
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

  detail.appendChild(boxEditor(ctx, selected));

  // Extract is the one verb that makes something outside this Segment, so it is the
  // block's only solid button, full width, on its own line.
  const extract = make('button', 'btn small segment-extract', 'Extract') as HTMLButtonElement;
  extract.dataset.segmentExtract = selected.id;
  extract.addEventListener('click', () => {
    ctx.run('Extract segment', async () => {
      await ctx.cut.extract(selected.id);
    });
  });

  detail.appendChild(extract);
  panel.appendChild(detail);
  // `recordingId` is kept in the signature: the editor is addressed by it even
  // though the session already holds the open Recording.
  void recordingId;
  return panel;
}

// --- Footage picker ----------------------------------------------------------

/**
 * The Segment's **box**: the rectangle of the source it is confined to.
 *
 * A Source whose backdrop the colour key cannot remove carries other colours into
 * the extract; a box is the way out, because it is applied before the key runs and
 * outside it nothing is measured. Drag on the frame to set one. The numbers are
 * read-only here — the drag is the editor, and one textual form next to it would
 * just be a second place to keep right.
 */
function boxEditor(ctx: RecordingInspectorPort, selected: Segment): HTMLElement {
  const block = make('div', 'segment-box');
  block.dataset.segmentBox = selected.id;

  if (selected.rect) {
    const rect = selected.rect;
    block.appendChild(
      make('p', 'segment-box-readout', `box ${rect.x},${rect.y} ${rect.width}×${rect.height}`),
    );
    const clear = make('button', 'btn small ghost', 'Whole frame') as HTMLButtonElement;
    clear.dataset.segmentBoxClear = selected.id;
    clear.title = 'Drop the box and extract the whole frame again';
    clear.addEventListener('click', () => {
      ctx.run('Clear box', () => ctx.cut.setBox(selected.id, null));
    });
    block.appendChild(clear);
  } else {
    block.appendChild(
      make('p', 'rail-hint', 'No box: the whole frame is extracted. Drag on the frame to box a part of it.'),
    );
  }

  const fit = make('button', 'btn small ghost', 'Box content') as HTMLButtonElement;
  fit.dataset.segmentBoxFit = selected.id;
  fit.title = 'Set the box to what survives the background key';
  fit.addEventListener('click', () => {
    ctx.run('Box content', () => ctx.cut.boxContent(selected.id));
  });
  block.appendChild(fit);
  return block;
}

/**
 * Open a Recording **for this Character**: the way footage enters a Character.
 *
 * Opening points Extract at it, so cutting a Segment can follow immediately
 * without re-picking the target each time.
 */
export function recordingPicker(ctx: RecordingInspectorPort, characterId: string): HTMLElement {
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
