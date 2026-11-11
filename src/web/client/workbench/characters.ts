/**
 * The Characters section of the Library rail.
 *
 * A **Character** is a level above both Recordings and Drafts: it owns the shared
 * Canvas/Anchor every one of its Assets is drawn on (GLOSSARY.md,
 * docs/alignment.md). Work therefore starts here — create or pick a Character,
 * then feed it footage. A new Character starts **blank** (a provisional Canvas) and
 * is framed from a real frame on its Alignment face, so nothing blocks the first
 * step, even in an empty store.
 *
 * Its Drafts and Assets are the Character's own, so they are nested under it and
 * shown only while it is open. Creating or opening one switches to that face: a
 * Character has no pixels of its own, only framing, and that face is where the
 * framing is shown, derived and grown.
 */

import type { BasePort, LibraryPort } from './ports.js';
import { make } from './dom.js';
import { activeAsset, activeDraft, type WorkbenchState } from './state.js';

/**
 * The Characters section: every Character in the store, plus the create form while
 * it is open.
 *
 * `open` is the Character whose work is on screen; only it is expanded, which
 * keeps the rail to one open branch however much the store holds.
 */
export function characterSection(ctx: LibraryPort, open: string | null): HTMLElement {
  const section = make('div', 'characters');
  section.dataset.librarySection = 'characters';
  if (ctx.state.railForm === 'character') {
    section.appendChild(createForm(ctx));
  }

  const characters = ctx.state.scan?.characters ?? [];
  if (characters.length === 0) {
    if (ctx.state.railForm !== 'character') {
      section.appendChild(make('p', 'rail-empty', 'no Characters yet'));
    }
    return section;
  }
  for (const character of characters) {
    section.appendChild(characterGroup(ctx, character.id, character.id === open));
  }
  return section;
}

/**
 * Create a Character by id, framed **from a Segment** or **blank**.
 *
 * Framing from a Segment is the default: the Canvas comes from the subject, so the
 * Character never starts on a guessed size. A blank Character keeps the
 * provisional Canvas and is framed later.
 */
function createForm(ctx: BasePort): HTMLElement {
  const form = make('form', 'rail-form character-create');
  form.dataset.characterAdd = '';

  const row = make('div', 'rail-form-row');
  const idInput = document.createElement('input');
  idInput.dataset.characterId = '';
  idInput.placeholder = 'new character id';
  idInput.setAttribute('aria-label', 'New Character id');

  const button = make('button', 'btn small', 'Create') as HTMLButtonElement;
  button.type = 'submit';
  button.dataset.characterAddRun = '';

  const message = make('p', 'rail-hint');
  message.dataset.characterMessage = '';

  // Where the Canvas comes from. Segment framing is the default; blank is the
  // escape hatch for a Character created before any footage exists.
  const source = document.createElement('select');
  source.dataset.characterSource = '';
  source.setAttribute('aria-label', 'Canvas source');
  for (const [value, label] of [
    ['segment', 'Frame from a Segment'],
    ['blank', 'Blank canvas'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    source.appendChild(option);
  }

  const framing = make('div', 'rail-form-stack');
  framing.dataset.characterFraming = '';
  const recordings = ctx.state.scan?.recordings ?? [];
  let cuts: readonly string[] = [];

  const recordingSelect = document.createElement('select');
  recordingSelect.dataset.characterRecordingSource = '';
  recordingSelect.setAttribute('aria-label', 'Recording to frame from');
  for (const recording of recordings) {
    const option = document.createElement('option');
    option.value = recording.id;
    option.textContent = recording.id;
    recordingSelect.appendChild(option);
  }

  const segmentSelect = document.createElement('select');
  segmentSelect.dataset.characterSegmentSource = '';
  segmentSelect.setAttribute('aria-label', 'Segment to frame from');

  const renderCuts = (): void => {
    segmentSelect.innerHTML = '';
    for (const cutId of cuts) {
      const option = document.createElement('option');
      option.value = cutId;
      option.textContent = cutId;
      segmentSelect.appendChild(option);
    }
    if (cuts.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'no segments in this Recording';
      segmentSelect.appendChild(option);
    }
  };

  const loadCuts = async (): Promise<void> => {
    cuts = [];
    if (recordings.length > 0) {
      try {
        const list = await ctx.api.readCutList(recordingSelect.value);
        cuts = list.cuts.map((cut) => cut.id);
      } catch {
        cuts = [];
      }
    }
    renderCuts();
  };

  recordingSelect.addEventListener('change', () => void loadCuts());
  void loadCuts();

  framing.append(recordingSelect, segmentSelect);

  const syncMessage = (): void => {
    framing.hidden = source.value !== 'segment';
    if (source.value === 'segment') {
      message.textContent = recordings.length
        ? 'the Canvas is framed from the chosen Segment'
        : 'no Recordings yet — import one, or use a blank canvas';
    } else {
      message.textContent = 'blank — frame it from footage afterwards';
    }
  };
  source.addEventListener('change', syncMessage);
  syncMessage();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void ctx.run('Create Character', () =>
      createCharacter(ctx, idInput.value.trim(), source.value, recordingSelect.value, segmentSelect.value, message),
    );
  });

  row.append(idInput, button);
  form.append(row, source, framing, message);
  return form;
}

async function createCharacter(
  ctx: BasePort,
  characterId: string,
  source: string,
  recordingId: string,
  cutId: string,
  message: HTMLElement,
): Promise<void> {
  if (!characterId) {
    message.textContent = 'a character id is required';
    return;
  }
  try {
    if (source === 'segment') {
      if (!recordingId || !cutId) {
        message.textContent = 'pick a Recording and a Segment to frame from';
        return;
      }
      // Derive first: a bad Segment then fails before the Character exists rather
      // than leaving a blank one behind.
      const derived = await ctx.api.deriveAnchor(recordingId, cutId);
      await ctx.api.createCharacter(characterId, {
        width: derived.canvas.width,
        height: derived.canvas.height,
        anchorX: derived.canvas.anchor.x,
        anchorY: derived.canvas.anchor.y,
      });
    } else {
      await ctx.api.createCharacter(characterId);
    }
    // The form closes once the Character exists: the rail goes back to being a list.
    ctx.state.railForm = 'none';
    await ctx.rescan();
    await ctx.loadCharacter(characterId);
  } catch (error) {
    message.textContent = (error as Error).message;
  }
}

/**
 * One Character, and — while it is open — the Drafts and Assets it owns.
 *
 * The row is a name, a count of everything the Character holds, and a disclosure
 * chevron. The counts are per kind inside the open branch, so the row itself only
 * has to say whether there is anything here at all.
 */
function characterGroup(ctx: LibraryPort, characterId: string, open: boolean): HTMLElement {
  const character = ctx.state.scan?.characters.find((entry) => entry.id === characterId);
  const total = (character?.drafts.length ?? 0) + (character?.assets.length ?? 0);
  const group = make('div', 'char-group');
  group.dataset.characterGroup = characterId;

  const head = make('button', 'asset char-head') as HTMLButtonElement;
  head.dataset.character = characterId;
  head.setAttribute('aria-expanded', String(open));
  head.classList.toggle('sel', open);
  head.classList.toggle('open', open);
  const chevron = make('span', 'chev', open ? '▾' : '▸');
  chevron.setAttribute('aria-hidden', 'true');
  head.append(
    chevron,
    make('span', 'asset-name', characterId),
    make('span', 'rail-count', String(total)),
  );
  head.addEventListener('click', () => openOrExtract(ctx, characterId));
  group.appendChild(head);

  if (open) {
    group.appendChild(characterContents(ctx, characterId));
  }
  return group;
}

/**
 * Open the Character — or, while a Segment is selected on an open Recording, hand
 * that Segment to it as a Draft.
 *
 * Picking a Character in the rail is the same question the save dialog asks, so it
 * answers it the same way: the Segment is extracted into the Character instead of
 * the Character merely opening beside an already-stored cut. Extraction is the
 * only verb that crosses faces on purpose (ADR-0012), and it lands on the Draft it
 * produced. With no cut in hand the row stays plain navigation.
 */
function openOrExtract(ctx: LibraryPort, characterId: string): void {
  const cutId = ctx.state.selectedCut;
  if (ctx.state.target.kind !== 'recording' || ctx.state.recordingId === null || cutId === null) {
    void ctx.loadCharacter(characterId);
    return;
  }
  // Extraction reads this, so the clicked Character wins over an earlier target.
  ctx.state.extractCharacterId = characterId;
  void ctx.run('Extract segment', async () => {
    // A declined expand (or any refusal) still opens the Character, so the click
    // never behaves worse than plain navigation.
    if (!(await ctx.cut.extract(cutId))) {
      await ctx.loadCharacter(characterId);
    }
  });
}

/** A Character's Drafts and committed Assets, as its own nested branches. */
function characterContents(ctx: BasePort, characterId: string): HTMLElement {
  const body = make('div', 'char-body');
  const character = ctx.state.scan?.characters.find((entry) => entry.id === characterId);

  const drafts = character?.drafts ?? [];
  if (drafts.length > 0) {
    body.appendChild(assetBranch(ctx, 'Drafts', 'drafts', drafts, ctx.state, characterId));
  }
  for (const kind of ['clip', 'sequence'] as const) {
    const assets = (character?.assets ?? []).filter((asset) => asset.kind === kind);
    if (assets.length > 0) {
      body.appendChild(assetBranch(ctx, kind === 'clip' ? 'Clips' : 'Sequences', kind, assets, ctx.state, characterId));
    }
  }
  // A Character with nothing made for it yet says so once, rather than three times.
  if (body.childElementCount === 0) {
    body.appendChild(make('p', 'rail-empty', 'nothing yet — open a Recording to cut one'));
  }
  return body;
}

/**
 * One nested list of a Character's work: its Drafts, its Clips, or its Sequences.
 *
 * Only branches with something in them render, so the open Character reads as a
 * list rather than as a form with empty slots.
 */
function assetBranch(
  ctx: BasePort,
  label: string,
  kind: 'drafts' | 'clip' | 'sequence',
  entries: readonly { id: string }[],
  state: WorkbenchState,
  characterId: string,
): HTMLElement {
  const branch = make('div', 'char-branch');
  branch.dataset.charBranch = kind;
  branch.appendChild(make('h4', 'ttl grp', label));
  const list = make('div', 'list');
  const openDraft = activeDraft(state);
  const openAsset = activeAsset(state);
  for (const entry of entries) {
    const item = make('button', 'asset');
    if (kind === 'drafts') {
      item.dataset.draft = entry.id;
      item.dataset.draftCharacter = characterId;
      item.classList.toggle(
        'sel',
        openDraft?.characterId === characterId && openDraft.draftId === entry.id,
      );
      item.append(make('span', 'asset-name', entry.id));
      item.addEventListener('click', () => void ctx.loadDraft(characterId, entry.id));
    } else {
      item.dataset.asset = entry.id;
      item.dataset.assetKind = kind;
      item.dataset.character = characterId;
      item.classList.toggle(
        'sel',
        openAsset?.characterId === characterId &&
          openAsset.assetId === entry.id &&
          openAsset.assetKind === kind,
      );
      item.append(make('span', 'asset-name', entry.id));
      // A committed Asset opens on the clip face, where it plays back and can be
      // forked; Alignment is one click away for when placement is the job.
      item.addEventListener('click', () => void ctx.loadAsset(characterId, kind, entry.id));
    }
    list.appendChild(item);
  }
  branch.appendChild(list);
  return branch;
}
