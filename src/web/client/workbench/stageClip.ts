/**
 * The Clip-editor stage: a **Draft**'s frames plus painting.
 *
 * A Draft is editable, so this face is the workbench's bench: it is mounted from
 * `./draftEditor.ts`. A committed Asset is a snapshot and gets its own read-only
 * View face (`./stageView.ts`) instead, so no control on screen has two
 * meanings. A Recording is not here either — cutting is its own face
 * (`./stageCut.ts`); Extract is the join into this one.
 */

import type { ClipStagePort } from './ports.js';
import { make } from './dom.js';

/** Render the Draft face, or the empty state. */
export function clipStageView(ctx: ClipStagePort): HTMLElement {
  if (ctx.state.target.kind === 'draft') {
    return ctx.draft.renderView();
  }

  const view = make('div', 'stage-view');
  view.dataset.stageView = 'clip-editor';
  view.dataset.emptyState = 'clip-editor';
  view.appendChild(
    make('p', 'muted', 'Clip editor — pick a Draft in the Library to repair it.'),
  );
  return view;
}
