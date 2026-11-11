/**
 * The inspector: facts and actions for whatever face is on screen.
 *
 * This module is the router only. The section follows the **target** (a
 * Recording, a Draft, a Character, an Export), not the mode, so the panel always
 * describes the thing in the stage next to it. Each target's section lives in
 * its own module and is mounted here; the `[data-region="inspector"]` node
 * itself persists.
 */

import type { InspectorPort } from './ports.js';
import { make } from './dom.js';
import { alignInspector } from './alignInspector.js';
import { assetInspector } from './assetInspector.js';
import { draftInspector } from './draftInspector.js';
import { exportInspector } from './exportInspector.js';
import { characterInspector, recordingInspector } from './recordingInspector.js';

/**
 * Render the inspector for the current target and mode.
 *
 * The panel is split top to bottom: what you reach for sits at the top, what you
 * read sits at the bottom. The information block is the one that scrolls, so a
 * long fact sheet never pushes the controls out of the panel.
 */
export function renderInspector(ctx: InspectorPort): void {
  const { inspector } = ctx.regions;
  const { state } = ctx;
  inspector.innerHTML = '';
  inspector.dataset.inspectorFor = state.mode;

  const actions = make('div', 'inspector-actions');
  actions.dataset.inspectorZone = 'actions';
  const info = make('div', 'inspector-info');
  info.dataset.inspectorZone = 'info';
  inspector.append(actions, info);

  if (state.loadError !== null) {
    const notice = make('p', 'muted load-error-note', state.loadError);
    notice.dataset.loadErrorNote = '';
    info.appendChild(notice);
  }

  if (state.mode === 'cut') {
    recordingInspector(ctx, actions, info);
  } else if (state.mode === 'align') {
    // Opening a Character lands here, so the Character's own section comes with
    // it: its Canvas is not the only thing a new Character still needs, and the
    // footage that frames it has to be reachable from the face you arrive on.
    if (state.target.kind === 'character') {
      characterInspector(ctx, state.target.characterId, actions, info);
    }
    alignInspector(ctx, actions, info);
  } else if (state.mode === 'export') {
    exportInspector(ctx, info);
  } else if (state.mode === 'compose') {
    if (state.target.kind === 'character') {
      characterInspector(ctx, state.target.characterId, actions, info);
    }
  } else if (state.target.kind === 'draft') {
    draftInspector(ctx, actions, info);
  } else if (state.target.kind === 'asset') {
    // Both the read-only View and the Clip editor fall back to the Asset's own
    // facts; only a Draft has an editor to mount.
    assetInspector(ctx, actions, info);
  } else if (state.target.kind === 'character') {
    characterInspector(ctx, state.target.characterId, actions, info);
  } else {
    recordingInspector(ctx, actions, info);
  }

  // A face with nothing to act on (Export) drops the empty top zone rather than
  // leaving a blank band above the facts.
  actions.hidden = actions.childElementCount === 0;
}
