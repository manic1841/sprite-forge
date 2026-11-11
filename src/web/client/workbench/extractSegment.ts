/**
 * Extract: turning a stored Segment into a Draft of its Character.
 *
 * The interesting part is not the call, it is the **refusal**. Extraction is a
 * hard error when the Segment does not fit the Canvas (ADR-0006), so the way out
 * depends on whether the Character has been drawn on yet, and this module owns
 * both branches.
 */

import type { WorkbenchApi } from '../api.js';
import { confirmAction } from './dialog.js';
import { askCharacterTarget, createCharacterFramedFrom, type CutTargetDeps } from './cutTargets.js';
import type { WorkbenchState } from './state.js';

/** What extraction needs beyond the shared target helpers. */
export interface ExtractDeps extends CutTargetDeps {
  readonly state: WorkbenchState;
  loadDraft(characterId: string, draftId: string): Promise<void>;
}

/**
 * Extract a Segment into its Character, then open the Draft it produced.
 *
 * @returns whether a Draft was opened.
 */
export async function extractSegment(deps: ExtractDeps, cutId: string): Promise<boolean> {
  const recordingId = deps.state.recordingId;
  if (!recordingId) {
    return false;
  }
  const characterId = await resolveTarget(deps, recordingId, cutId);
  if (characterId === null) {
    return false;
  }
  const draft = await extractDraftInto(deps, characterId, recordingId, cutId);
  if (draft === null) {
    return false;
  }
  await deps.rescan();
  await deps.loadDraft(characterId, draft.id);
  return true;
}

/**
 * The Character to extract into, for a Segment saved before one was chosen.
 *
 * The ask is normally answered at save time, so this is the fallback that keeps
 * an older Segment usable. Either answer then sticks for the Recording.
 */
async function resolveTarget(
  deps: ExtractDeps,
  recordingId: string,
  cutId: string,
): Promise<string | null> {
  if (deps.state.extractCharacterId !== null) {
    return deps.state.extractCharacterId;
  }

  const target = await askCharacterTarget(
    deps,
    'Extract this Segment into which Character?',
    'Extract',
    'New Character id to extract into:',
  );
  if (target === null) {
    return null;
  }
  if (target.newId === null) {
    deps.state.extractCharacterId = target.characterId;
    return target.characterId;
  }
  return await createCharacterFramedFrom(deps, recordingId, cutId, target.newId);
}

/**
 * Extract, repairing the framing when the Segment does not fit the Canvas.
 *
 * The way out depends on whether the Character has been drawn on yet:
 *
 *   - **blank** — its Canvas is only the provisional placeholder, so it is
 *     replaced outright by the framing this Segment implies (`frameCanvas`),
 *     which may be *smaller* than the placeholder. Expand cannot do that: it
 *     refuses to shrink.
 *   - **drawn on** — only growing is safe, so the expand is offered at the larger
 *     of the current and derived size on each axis, and needs a confirmation.
 */
async function extractDraftInto(
  deps: ExtractDeps,
  characterId: string,
  recordingId: string,
  cutId: string,
): Promise<{ id: string } | null> {
  const { api, state } = deps;
  try {
    return await api.extractClipDraft(characterId, { recordingId, cutId });
  } catch (error) {
    const message = (error as Error).message;
    if (!/canvas/i.test(message)) {
      throw error;
    }

    // A blank Character is only held back by the placeholder: framing it from
    // this Segment settles the Canvas the Segment was measured against. A
    // drawn-on Character may instead refuse because framing would shrink, which
    // is the case the expand below covers — so a failure falls through, not up.
    try {
      await api.frameCanvas(characterId, { recordingId, cutId });
      return await api.extractClipDraft(characterId, { recordingId, cutId });
    } catch {
      // Fall through to the expand offer.
    }

    // Drawn on: grow only, and never below what the Canvas already is.
    const derived = await api.deriveAnchor(recordingId, cutId);
    const canvas =
      state.alignment?.canvas ?? (await api.readCharacterAlignment(characterId)).canvas;
    const width = Math.max(canvas.width, derived.canvas.width);
    const height = Math.max(canvas.height, derived.canvas.height);
    const offered = await confirmAction(
      `${message}\n\nExpand "${characterId}" to ${width}×${height}` +
        ` (from ${canvas.width}×${canvas.height}) and extract?`,
      'Expand and extract',
    );
    if (!offered) {
      return null;
    }
    await api.expandCanvas(characterId, width, height);
    return await api.extractClipDraft(characterId, { recordingId, cutId });
  }
}

/** The API surface the flow touches, re-exported for tests that stub it. */
export type ExtractApi = Pick<
  WorkbenchApi,
  | 'extractClipDraft'
  | 'frameCanvas'
  | 'expandCanvas'
  | 'deriveAnchor'
  | 'readCharacterAlignment'
>;
