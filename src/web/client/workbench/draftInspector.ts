/**
 * The inspector for an open **Draft**: its per-frame facts, the Repair log, and
 * the two exits.
 *
 * The pixels and the tools that write them are the draft editor's; what is left
 * for the inspector is the part you *read* — the frame's provenance, the replay
 * record, and the choice to keep or throw the Draft away.
 */

import type { DraftInspectorPort } from './ports.js';
import { addRow, make, subheading } from './dom.js';
import { targetFrames } from './draftEditor.js';
import type { ClipDraft } from '../types.js';

/** The active Draft's per-frame facts, its Repair slot, and Commit. */
export function draftInspector(
  ctx: DraftInspectorPort,
  actions: HTMLElement,
  info: HTMLElement,
): void {
  const draft = ctx.state.draftDescriptor;
  const target = ctx.state.target.kind === 'draft' ? ctx.state.target : null;

  const facts = make('section', 'inspector-section');
  facts.dataset.inspectorSection = 'draft';
  facts.appendChild(subheading('Draft'));

  if (!draft || !target) {
    facts.appendChild(make('p', 'muted', 'Select a Draft to inspect its frames.'));
  } else {
    const list = make('dl', 'kv');
    addRow(list, 'character', target.characterId);
    addRow(list, 'draft', target.draftId);
    addRow(list, 'recording', draft.recordingId);
    addRow(
      list,
      'segment',
      `${draft.segment.cutId} [${draft.segment.startFrame}, ${draft.segment.endFrame})`,
    );
    addRow(list, 'frames', String(draft.frameCount));
    addRow(list, 'frame', String(ctx.state.draftFrame));
    addRow(list, 'delay', `${draftDelayMs(draft, ctx.state.draftFrame)} ms`);
    addRow(list, 'background', draft.background.hex);
    addRow(list, 'loop', String(draft.loop));
    facts.appendChild(list);
  }
  info.appendChild(facts);

  // The Repair *tools* live under the frame in the stage; what stays here is the
  // part you read rather than reach for: the warnings and the replay log.
  const repair = make('section', 'inspector-section');
  repair.dataset.inspectorSection = 'repair';
  repair.appendChild(subheading('Repair log'));
  repair.appendChild(ctx.draft.repairLog());
  info.appendChild(repair);

  // The two ways out of a Draft go at the top: commit it, or throw it away.
  actions.appendChild(ctx.draft.commitSection());
  actions.appendChild(ctx.draft.discardSection());
}

/** A Draft frame's delay: `delaysMs` is either uniform (1) or per-frame. */
function draftDelayMs(draft: ClipDraft, frame: number): number {
  const index = Math.min(frame, draft.delaysMs.length - 1);
  return draft.delaysMs[index] ?? draft.delaysMs[0] ?? 0;
}

/** Re-exported so the stage and inspector agree on what an edit targets. */
export { targetFrames };
