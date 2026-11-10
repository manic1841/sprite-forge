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

import type { WorkbenchContext } from './context.js';
import { make } from './dom.js';
import { activeAsset, activeDraft, type WorkbenchState } from './state.js';

/**
 * The Characters section: every Character in the store, plus the create form while
 * it is open.
 *
 * `open` is the Character whose work is on screen; only it is expanded, which
 * keeps the rail to one open branch however much the store holds.
 */
export function characterSection(ctx: WorkbenchContext, open: string | null): HTMLElement {
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
 * Create a **blank** Character by id.
 *
 * No footage is needed: the Character starts on a provisional Canvas and is framed
 * later (derive from a frame, or expand). Nothing about cutting a Recording is
 * implied by creating one.
 */
function createForm(ctx: WorkbenchContext): HTMLElement {
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

  // Nothing about cutting a Recording is implied by creating one, so the only
  // hint is what the Character is for: a blank Canvas framed later.
  const message = make('p', 'rail-hint');
  message.dataset.characterMessage = '';
  message.textContent = 'blank — frame it from footage afterwards';

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void ctx.run('Create Character', () =>
      createCharacter(ctx, idInput.value.trim(), message),
    );
  });

  row.append(idInput, button);
  form.append(row, message);
  return form;
}

async function createCharacter(
  ctx: WorkbenchContext,
  characterId: string,
  message: HTMLElement,
): Promise<void> {
  if (!characterId) {
    message.textContent = 'a character id is required';
    return;
  }
  try {
    await ctx.api.createCharacter(characterId);
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
function characterGroup(ctx: WorkbenchContext, characterId: string, open: boolean): HTMLElement {
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
  head.addEventListener('click', () => void ctx.loadCharacter(characterId));
  group.appendChild(head);

  if (open) {
    group.appendChild(characterContents(ctx, characterId));
  }
  return group;
}

/** A Character's Drafts and committed Assets, as its own nested branches. */
function characterContents(ctx: WorkbenchContext, characterId: string): HTMLElement {
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
  ctx: WorkbenchContext,
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
