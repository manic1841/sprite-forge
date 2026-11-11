/**
 * The **Compose** stage: a Character's Sequence composition.
 *
 * A Sequence has no frames of its own — its recipe *is* the ordered Clip list
 * (Rule 7.2) — so composing is its own face, on the **Character**: a composition
 * can start before any Sequence Asset exists, and the Character is what its
 * Clips belong to. Each edit is persisted to a Sequence draft, so a half-built
 * composition survives a reload like a frame Draft does. Committing bakes a new,
 * immutable Sequence and consumes the draft.
 */

import type { BasePort } from './ports.js';
import { labeled, make } from './dom.js';
import type { SequenceDraft } from './state.js';

/** Render the composition editor, the draft picker, or the empty state. */
export function composeStageView(ctx: BasePort): HTMLElement {
  const view = make('div', 'stage-view');
  view.dataset.stageView = 'compose';

  const characterId = ctx.state.activeCharacterId;
  if (characterId === null) {
    view.dataset.emptyState = 'compose';
    view.appendChild(make('p', 'muted', 'Compose — pick a Character in the Library.'));
    return view;
  }

  const open = ctx.state.sequenceDraft;
  const draft = open && open.characterId === characterId ? open : null;
  view.appendChild(draft === null ? picker(ctx, characterId) : editor(ctx, characterId, draft));
  return view;
}

/** The persisted compositions plus the "new" action. */
function picker(ctx: BasePort, characterId: string): HTMLElement {
  const panel = make('section', 'segments');
  panel.dataset.sequencePanel = '';
  panel.appendChild(make('h3', 'ttl sub', 'Compositions'));

  const drafts =
    ctx.state.scan?.characters.find((candidate) => candidate.id === characterId)
      ?.sequenceDrafts ?? [];

  if (drafts.length === 0) {
    panel.appendChild(make('p', 'muted', 'No composition yet — start one below.'));
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
    panel.appendChild(list);
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
  panel.appendChild(start);
  return panel;
}

/** The open composition: its Clips, its order, its exits. */
function editor(ctx: BasePort, characterId: string, draft: SequenceDraft): HTMLElement {
  const panel = make('section', 'segments');
  panel.dataset.sequencePanel = '';
  panel.appendChild(make('h3', 'ttl sub', 'Composition'));

  if (draft.forkOf !== null) {
    panel.appendChild(make('p', 'muted', `Forked from "${draft.forkOf}".`));
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
    item.appendChild(make('span', 'sequence-clip', clipId));

    const up = make('button', 'btn small ghost', '↑') as HTMLButtonElement;
    up.dataset.sequenceUp = '';
    up.disabled = index === 0;
    up.addEventListener('click', () => move(ctx, characterId, index, -1));

    const down = make('button', 'btn small ghost', '↓') as HTMLButtonElement;
    down.disabled = index === draft.clips.length - 1;
    down.addEventListener('click', () => move(ctx, characterId, index, 1));

    const remove = make('button', 'btn small ghost', 'Remove') as HTMLButtonElement;
    remove.dataset.sequenceRemove = '';
    remove.addEventListener('click', () => {
      draft.clips.splice(index, 1);
      void persist(ctx, draft);
    });

    item.append(up, down, remove);
    list.appendChild(item);
  });
  panel.appendChild(list);

  const addRow = make('label', 'field');
  addRow.append(make('span', 'k', 'add clip'));
  const addSelect = document.createElement('select');
  addSelect.dataset.sequenceAdd = '';
  const clips =
    ctx.state.scan?.characters
      .find((candidate) => candidate.id === characterId)
      ?.assets.filter((asset) => asset.kind === 'clip') ?? [];
  for (const clip of clips) {
    const option = document.createElement('option');
    option.value = clip.id;
    option.textContent = clip.id;
    addSelect.appendChild(option);
  }
  addRow.appendChild(addSelect);
  panel.appendChild(addRow);

  const add = make('button', 'btn small', 'Add') as HTMLButtonElement;
  add.dataset.sequenceAddRun = '';
  add.disabled = clips.length === 0;
  add.addEventListener('click', () => {
    if (!addSelect.value) {
      return;
    }
    draft.clips.push(addSelect.value);
    void persist(ctx, draft);
  });
  panel.appendChild(add);

  const name = document.createElement('input');
  name.dataset.sequenceName = '';
  name.value = draft.id;

  const commitRow = make('div', 'commit-row');
  const commit = make('button', 'btn small', 'Commit sequence') as HTMLButtonElement;
  commit.dataset.sequenceCommit = '';
  commit.addEventListener('click', () => {
    ctx.run('Commit sequence', () => commitDraft(ctx, characterId, draft, name.value.trim()));
  });
  const cancel = make('button', 'btn small ghost', 'Close') as HTMLButtonElement;
  cancel.addEventListener('click', () => {
    ctx.state.sequenceDraft = null;
    ctx.renderStage();
    ctx.renderInspector();
  });
  const discard = make('button', 'btn small ghost', 'Discard draft') as HTMLButtonElement;
  discard.dataset.sequenceDiscard = '';
  discard.addEventListener('click', () => {
    ctx.run('Discard composition', async () => {
      await ctx.api.discardSequenceDraft(characterId, draft.id);
      ctx.state.sequenceDraft = null;
      await ctx.rescan();
      ctx.renderStage();
      ctx.renderInspector();
    });
  });
  commitRow.append(commit, cancel, discard);

  panel.append(labeled('sequence name', name), commitRow);
  return panel;
}

/** Save the composition after an edit. */
async function persist(ctx: BasePort, draft: SequenceDraft): Promise<void> {
  await ctx.api.saveSequenceDraft(draft.characterId, {
    draftId: draft.id,
    clips: draft.clips,
    forkOf: draft.forkOf,
  });
  ctx.renderStage();
  ctx.renderInspector();
}

function move(ctx: BasePort, characterId: string, index: number, delta: number): void {
  const draft = ctx.state.sequenceDraft;
  const swap = index + delta;
  if (!draft || draft.characterId !== characterId || swap < 0 || swap >= draft.clips.length) {
    return;
  }
  [draft.clips[index], draft.clips[swap]] = [draft.clips[swap]!, draft.clips[index]!];
  void persist(ctx, draft);
}

async function commitDraft(
  ctx: BasePort,
  characterId: string,
  draft: SequenceDraft,
  name: string,
): Promise<void> {
  if (draft.clips.length === 0) {
    throw new Error('a Sequence needs at least one Clip');
  }
  const id = name || draft.id;
  const committed = await ctx.api.commitSequence(
    characterId,
    id,
    draft.clips,
    draft.id,
    draft.forkOf ?? undefined,
  );
  ctx.state.sequenceDraft = null;
  // Committing is additive: land on the Asset that was just written.
  await ctx.rescan();
  await ctx.loadAsset(characterId, 'sequence', committed.id);
}
