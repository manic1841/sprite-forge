/**
 * The **Compose** stage: the composition, played back.
 *
 * A Sequence has no frames of its own — its recipe *is* the ordered Clip list
 * (Rule 7.2) — so composing is its own face, on the **Character**: a composition
 * can start before any Sequence Asset exists, and the Character is what its
 * Clips belong to.
 *
 * The stage is **only the picture**. A composition exists to join cut footage, and
 * the seam is the thing under judgement, so the preview gets the whole pane and
 * everything you operate — the Clip list, the name, commit — lives in the panel
 * (`composeInspector`). Placement is baked into a committed Clip, so the
 * preview's *Align…* forks one and comes straight back here with the fork's commit
 * taking that slot (see `sequencePreview.realign`).
 */

import type { ComposeStagePort } from './ports.js';
import { make } from './dom.js';

/** Render the composition preview, or the state that says what to open. */
export function composeStageView(ctx: ComposeStagePort): HTMLElement {
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
  if (draft === null) {
    view.dataset.emptyState = 'compose';
    view.appendChild(
      make('p', 'muted', 'No composition open — pick one, or start a new one, in the panel.'),
    );
    return view;
  }

  // The slots are re-read whenever the Clip list changed; the render below paints
  // whatever the slice holds now.
  void ctx.preview.sync(draft);
  view.appendChild(ctx.preview.render());
  return view;
}
