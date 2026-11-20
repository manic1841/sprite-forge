/**
 * The inspector for an open **Draft**: its per-frame facts, the Repair log, and
 * the two exits.
 *
 * The pixels and the tools that write them are the draft editor's; what is left
 * for the inspector is the part you *read* — the frame's provenance, the replay
 * record, and the choice to keep or throw the Draft away.
 */

import type { DraftInspectorPort } from './ports.js';
import { addRow, labeled, make, numberInput, subheading } from './dom.js';
import { targetFrames } from './draftEditor.js';
import { timingFromDelays } from '../../../core/timing.js';
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
    // The frame above is shown turned when this is on; the stored pixels are not.
    addRow(list, 'mirror', draft.flipX === true ? 'on' : 'off');
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
  if (draft) {
    actions.appendChild(timingSection(ctx, draft));
  }
  actions.appendChild(ctx.draft.discardSection());
}

/** A Draft frame's delay: `delaysMs` is either uniform (1) or per-frame. */
function draftDelayMs(draft: ClipDraft, frame: number): number {
  const index = Math.min(frame, draft.delaysMs.length - 1);
  return draft.delaysMs[index] ?? draft.delaysMs[0] ?? 0;
}

/**
 * The timing control: one rate for the whole Clip, offered in ms and fps at once.
 *
 * Frames-per-second is the unit people think in, but ms is what the artifacts say
 * (format-spec §0), so the input reads milliseconds and the fps is the readout
 * beside it. Writing pins every frame (the Draft records `uniformDelayMs`); when
 * the source's own cadence is still in play, that is said plainly and a button
 * offers the source's hiccups back.
 */
/**
 * Pending ms write. The write re-renders the inspector, which replaces the input,
 * so a per-keystroke write would steal the field out from under the typist. A short
 * debounce collapses a burst into one write, like the alignment offsets do.
 */
let timingTimer: ReturnType<typeof setTimeout> | null = null;

function timingSection(ctx: DraftInspectorPort, draft: ClipDraft): HTMLElement {
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'timing';
  section.appendChild(subheading('Timing'));

  const pinned = draft.uniformDelayMs !== undefined;
  const distinct = new Set(draft.delaysMs).size;
  const base = pinned ? draft.uniformDelayMs! : (timingFromDelays(draft.delaysMs).frameMs);
  const differing = draft.delaysMs.filter((delay) => delay !== base).length;

  const ms = numberInput(base, 'Milliseconds per frame', () => {
    const typed = Math.round(Number(ms.value));
    if (!Number.isFinite(typed) || typed < 1 || typed === (pinned ? base : -1)) {
      return;
    }
    fps.textContent = `${(1000 / typed).toFixed(2)} fps`;
    if (timingTimer !== null) {
      clearTimeout(timingTimer);
    }
    timingTimer = setTimeout(() => {
      timingTimer = null;
      ctx.run('Set frame timing', async () => {
        ctx.state.draftDescriptor = await ctx.api.setDraftFrameMs(
          draft.characterId,
          draft.id,
          typed,
        );
        ctx.renderInspector();
      });
    }, 300);
  });
  ms.dataset.draftFrameMs = '';

  const fps = make('span', 'timing-fps', `${(1000 / base).toFixed(2)} fps`);
  fps.dataset.draftFps = '';
  const row = make('div', 'align-offsets');
  row.append(labeled('ms / frame', ms), fps);
  section.appendChild(row);

  const state = make('p', 'muted');
  state.dataset.draftTimingState = '';
  state.textContent = pinned
    ? `Pinned to ${base} ms on every frame.`
    : distinct === 1
      ? 'Every frame already has the same duration.'
      : `Source cadence kept: ${differing} of ${draft.frameCount} frames differ from ${base} ms.`;
  section.appendChild(state);

  if (pinned) {
    const restore = make('button', 'btn small', 'Restore source timing');
    restore.dataset.draftTimingRestore = '';
    restore.addEventListener('click', () => {
      void ctx.run('Restore source timing', async () => {
        ctx.state.draftDescriptor = await ctx.api.restoreDraftTiming(
          draft.characterId,
          draft.id,
        );
        ctx.renderInspector();
      });
    });
    section.appendChild(restore);
  }
  return section;
}

/** Re-exported so the stage and inspector agree on what an edit targets. */
export { targetFrames };
