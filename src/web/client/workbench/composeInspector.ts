/**
 * The inspector for **Compose**: the composition's order, its name, and its exits.
 *
 * The composition's subject is the preview — the seam, at the size a seam needs —
 * so the stage is only pixels here and everything you *operate* lives in the
 * panel: the Clip list and its order, the Clip being added, the name the Sequence
 * will carry, and committing or dropping the draft.
 *
 * The Clip list is the composition's recipe (Rule 7.2), which makes it a control
 * rather than a readout: each row is where a Clip is moved, removed, or handed to
 * the placement editor.
 */

import type { ComposeInspectorPort } from './ports.js';
import { addRow, labeled, make, subheading } from './dom.js';
import type { SequenceDraft } from './state.js';

/** The composition picker, or the open composition's controls. */
export function composeInspector(
  ctx: ComposeInspectorPort,
  characterId: string,
  actions: HTMLElement,
  info: HTMLElement,
): void {
  const open = ctx.state.sequenceDraft;
  const draft = open && open.characterId === characterId ? open : null;
  actions.appendChild(draft === null ? picker(ctx, characterId) : editor(ctx, draft));
  info.appendChild(characterFacts(ctx, characterId));
}

/** The persisted compositions plus the "new" action. */
function picker(ctx: ComposeInspectorPort, characterId: string): HTMLElement {
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'compositions';
  section.appendChild(subheading('Compositions'));

  const drafts =
    ctx.state.scan?.characters.find((candidate) => candidate.id === characterId)
      ?.sequenceDrafts ?? [];

  if (drafts.length === 0) {
    section.appendChild(make('p', 'muted', 'No composition yet — start one below.'));
  } else {
    const list = make('ul', 'sequence-list');
    for (const draft of drafts) {
      const item = make('li', 'sequence-item');
      item.dataset.sequenceDraftItem = draft.id;
      item.appendChild(make('span', 'sequence-clip', draft.id));
      const open = make('button', 'btn small', 'Open') as HTMLButtonElement;
      open.dataset.sequenceDraftOpen = draft.id;
      open.addEventListener('click', () => {
        void ctx.run('Open composition', async () => {
          ctx.state.sequenceDraft = await ctx.api.readSequenceDraft(characterId, draft.id);
          ctx.renderStage();
          ctx.renderInspector();
        });
      });
      item.appendChild(open);
      list.appendChild(item);
    }
    section.appendChild(list);
  }

  const start = make('button', 'btn small', 'New composition') as HTMLButtonElement;
  start.dataset.sequenceNew = '';
  start.addEventListener('click', () => {
    void ctx.run('New composition', async () => {
      ctx.state.sequenceDraft = await ctx.api.saveSequenceDraft(characterId, { clips: [] });
      await ctx.rescan();
      ctx.renderStage();
      ctx.renderInspector();
    });
  });
  section.appendChild(start);
  return section;
}

/** The open composition: its Clips, their order, and what ends it. */
function editor(ctx: ComposeInspectorPort, draft: SequenceDraft): HTMLElement {
  const { state } = ctx;
  const { characterId } = draft;
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'composition';
  section.appendChild(subheading('Composition'));
  // The draft id is the identity the panel edits; it is too long to be a heading,
  // so it is quiet under it.
  section.appendChild(make('p', 'sequence-id', draft.id));

  if (draft.forkOf !== null) {
    section.appendChild(make('p', 'muted', `Forked from "${draft.forkOf}".`));
  }

  const realign = state.realign;
  if (realign && realign.draftId === draft.id) {
    const note = make(
      'p',
      'muted',
      `Re-aligning "${realign.clipId}" (slot ${realign.slot + 1}). The seam is parked ` +
        'in the preview; commit or drop the fork above.',
    );
    note.dataset.sequenceRealign = '';
    section.appendChild(note);
  }

  const list = make('ol', 'sequence-list');
  list.dataset.sequenceList = '';
  if (draft.clips.length === 0) {
    list.appendChild(make('li', 'muted', 'No Clips yet — add one below.'));
  }
  draft.clips.forEach((clipId, index) => {
    const item = make('li', 'sequence-item');
    item.dataset.sequenceClip = clipId;
    item.dataset.sequenceIndex = String(index);
    // The position is the recipe's order made visible, so it stays on the row: a
    // Sequence's meaning is where each Clip sits, not only which ones are in it.
    const step = make('span', 'sequence-step', String(index + 1));
    item.appendChild(step);
    item.appendChild(make('span', 'sequence-clip', clipId));

    // Order is the only edit that belongs on every row, so the arrows stay on it.
    const up = make('button', 'btn small ghost', '↑') as HTMLButtonElement;
    up.dataset.sequenceUp = '';
    up.disabled = index === 0;
    up.title = `Move ${clipId} earlier`;
    up.addEventListener('click', () => move(ctx, index, -1));

    const down = make('button', 'btn small ghost', '↓') as HTMLButtonElement;
    down.dataset.sequenceDown = '';
    down.disabled = index === draft.clips.length - 1;
    down.title = `Move ${clipId} later`;
    down.addEventListener('click', () => move(ctx, index, 1));

    // The panel is narrow, so the placement verb is a mark rather than a word: the
    // name beside it is what has to stay readable.
    const align = make('button', 'btn small ghost', '⌖') as HTMLButtonElement;
    align.dataset.sequenceAlignRow = String(index);
    align.setAttribute('aria-label', `Adjust the placement of ${clipId}`);
    // The row being adjusted says so, and stays pressable: pressing it again
    // brings the playhead back to its seam.
    const adjusting = realign !== null && realign.slot === index;
    if (adjusting) {
      align.dataset.active = '';
      align.title = `Adjusting ${clipId} — back to the seam before it`;
    } else {
      align.title =
        realign === null
          ? `Adjust ${clipId}'s placement, with the seam in view`
          : `Switch the adjustment to ${clipId} — the current fork is dropped`;
    }
    align.setAttribute('aria-pressed', String(adjusting));
    align.addEventListener('click', () => ctx.preview.realign(index));

    const remove = make('button', 'btn small ghost', '✕') as HTMLButtonElement;
    remove.dataset.sequenceRemove = '';
    remove.title = `Remove ${clipId} from the composition`;
    remove.setAttribute('aria-label', `Remove ${clipId}`);
    remove.addEventListener('click', () => {
      draft.clips.splice(index, 1);
      void persist(ctx);
    });

    item.append(up, down, align, remove);
    list.appendChild(item);
  });
  section.appendChild(list);

  const addRowEl = make('div', 'sequence-add');
  const select = document.createElement('select');
  select.dataset.sequenceAdd = '';
  select.setAttribute('aria-label', 'Clip to add');
  const clips =
    ctx.state.scan?.characters
      .find((candidate) => candidate.id === characterId)
      ?.assets.filter((asset) => asset.kind === 'clip') ?? [];
  for (const clip of clips) {
    const option = document.createElement('option');
    option.value = clip.id;
    option.textContent = clip.id;
    select.appendChild(option);
  }
  const add = make('button', 'btn small', 'Add') as HTMLButtonElement;
  add.dataset.sequenceAddRun = '';
  add.disabled = clips.length === 0;
  add.addEventListener('click', () => {
    if (!select.value) {
      return;
    }
    draft.clips.push(select.value);
    void persist(ctx);
  });
  addRowEl.append(select, add);
  section.appendChild(addRowEl);

  // The name is what commit will call the Sequence, so it is read here and given
  // in the Commit row rather than saved on its own.
  const name = document.createElement('input');
  name.dataset.sequenceName = '';
  name.value = draft.id;
  section.appendChild(labeled('sequence name', name));

  const exits = make('div', 'commit-row');
  const commit = make('button', 'btn small', 'Commit sequence') as HTMLButtonElement;
  commit.dataset.sequenceCommit = '';
  commit.addEventListener('click', () => {
    ctx.run('Commit sequence', () => commitDraft(ctx, draft, name.value.trim()));
  });
  const close = make('button', 'btn small ghost', 'Close') as HTMLButtonElement;
  close.dataset.sequenceClose = '';
  close.title = 'Leave the composition open, as it is';
  close.addEventListener('click', () => {
    ctx.preview.clear();
    ctx.state.sequenceDraft = null;
    ctx.renderStage();
    ctx.renderInspector();
  });
  const discard = make('button', 'btn small ghost', 'Discard draft') as HTMLButtonElement;
  discard.dataset.sequenceDiscard = '';
  discard.addEventListener('click', () => {
    ctx.run('Discard composition', async () => {
      await ctx.api.discardSequenceDraft(characterId, draft.id);
      ctx.preview.clear();
      ctx.state.sequenceDraft = null;
      await ctx.rescan();
      ctx.renderStage();
      ctx.renderInspector();
    });
  });
  exits.append(commit, close, discard);
  section.appendChild(exits);

  return section;
}

/** The Character the composition belongs to: what it is, and what it owns. */
function characterFacts(ctx: ComposeInspectorPort, characterId: string): HTMLElement {
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'character';
  section.appendChild(subheading('Character'));
  const character = ctx.state.scan?.characters.find((entry) => entry.id === characterId);
  const list = make('dl', 'kv');
  addRow(list, 'character', characterId);
  addRow(list, 'clips', String(character?.assets.filter((a) => a.kind === 'clip').length ?? 0));
  addRow(list, 'sequences', String(character?.assets.filter((a) => a.kind === 'sequence').length ?? 0));
  section.appendChild(list);
  section.appendChild(make('p', 'muted', 'Placement is edited on the seam, with Align…'));
  return section;
}

/**
 * Save the composition after an edit.
 *
 * `forkOf` is left out unless there is one: a plain composition has none, and a
 * `null` is not a string to the API. The save runs through `ctx.run` so a refusal
 * lands in the action banner instead of an unhandled rejection the click can
 * swallow.
 */
function persist(ctx: ComposeInspectorPort): void {
  const draft = ctx.state.sequenceDraft;
  if (!draft) {
    return;
  }
  ctx.run('Save composition', async () => {
    await ctx.api.saveSequenceDraft(draft.characterId, {
      draftId: draft.id,
      clips: draft.clips,
      ...(draft.forkOf === null ? {} : { forkOf: draft.forkOf }),
    });
    ctx.renderStage();
    ctx.renderInspector();
  });
}

function move(ctx: ComposeInspectorPort, index: number, delta: number): void {
  const draft = ctx.state.sequenceDraft;
  const swap = index + delta;
  if (!draft || swap < 0 || swap >= draft.clips.length) {
    return;
  }
  [draft.clips[index], draft.clips[swap]] = [draft.clips[swap]!, draft.clips[index]!];
  void persist(ctx);
}

async function commitDraft(ctx: ComposeInspectorPort, draft: SequenceDraft, name: string): Promise<void> {
  if (draft.clips.length === 0) {
    throw new Error('a Sequence needs at least one Clip');
  }
  const id = name || draft.id;
  const committed = await ctx.api.commitSequence(
    draft.characterId,
    id,
    draft.clips,
    draft.id,
    draft.forkOf ?? undefined,
  );
  ctx.state.sequenceDraft = null;
  // Committing is additive: land on the Asset that was just written.
  ctx.preview.clear();
  await ctx.rescan();
  await ctx.loadAsset(draft.characterId, 'sequence', committed.id);
}
