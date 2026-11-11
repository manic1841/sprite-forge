/**
 * Asking **which Character** a Segment belongs to, and creating one from a cut.
 *
 * Both saving a Segment and extracting one have to answer the same question, on
 * the same list, with the same wording. Keeping it here means the two flows
 * cannot drift apart, and neither has to know how a Character is framed.
 */

import type { WorkbenchApi } from '../api.js';
import { chooseAction, promptText } from './dialog.js';
import type { WorkbenchState } from './state.js';

/** The "new Character" radio's value, in both asks. */
export const NEW_CHARACTER = '\u0000 new';

/** What the ask needs: the store, the scan to choose from, and a rescan hook. */
export interface CutTargetDeps {
  readonly api: WorkbenchApi;
  readonly state: WorkbenchState;
  rescan(): Promise<void>;
}

/** An answer: an existing Character, or an id to create. */
export interface CharacterTarget {
  characterId: string | null;
  newId: string | null;
}

/**
 * Ask which Character a Segment is for.
 *
 * The first existing Character is preselected so the dialog answers with one
 * Enter, but nothing is decided on the user's behalf — and with no Character in
 * the store, the only branch offered is the new one.
 */
export async function askCharacterTarget(
  deps: CutTargetDeps,
  question: string,
  confirmLabel: string,
  newPrompt: string,
): Promise<CharacterTarget | null> {
  const characters = deps.state.scan?.characters ?? [];
  if (characters.length > 0) {
    const picked = await chooseAction(
      question,
      [
        ...characters.map((character) => ({
          value: character.id,
          label: character.id,
          note: `${character.drafts.length} draft(s) · ${character.assets.length} asset(s)`,
        })),
        {
          value: NEW_CHARACTER,
          label: 'New Character…',
          note: 'named next, framed from this cut',
          kind: 'create' as const,
        },
      ],
      confirmLabel,
    );
    if (picked === null) {
      return null;
    }
    if (picked !== NEW_CHARACTER) {
      return { characterId: picked, newId: null };
    }
  }

  const newId = (await promptText(newPrompt, '', 'Create'))?.trim();
  return newId ? { characterId: null, newId } : null;
}

/** Create a Character whose Canvas and Anchor are framed from a stored cut. */
export async function createCharacterFramedFrom(
  deps: CutTargetDeps,
  recordingId: string,
  cutId: string,
  characterId: string,
): Promise<string> {
  const derived = await deps.api.deriveAnchor(recordingId, cutId);
  await deps.api.createCharacter(characterId, {
    width: derived.canvas.width,
    height: derived.canvas.height,
    anchorX: derived.canvas.anchor.x,
    anchorY: derived.canvas.anchor.y,
  });
  deps.state.extractCharacterId = characterId;
  deps.state.activeCharacterId = characterId;
  return characterId;
}
