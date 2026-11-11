/**
 * The store's id grammar.
 *
 * Ids are lowercase ASCII kebab-case (format-spec §0): a folder name must equal
 * the id it holds, so an id is also a safe path segment. One place defines the
 * pattern so ids are checked identically wherever they enter the store.
 */

import { StoreError } from './errors.js';

/** The id grammar, exactly as the frozen schemas encode it. */
export const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Is `value` a valid store id? */
export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/**
 * Reject an id that does not match the id grammar before it becomes a path
 * segment. `noun` names the entity ("character", "recording") and `label` names
 * the field in the message (e.g. `"recordingId"` or `Situation "idle"`).
 */
export function assertValidId(id: string, noun: string, label: string): void {
  if (!isValidId(id)) {
    throw new StoreError(`Invalid ${label} "${id}" (${noun} id): must match /^[a-z][a-z0-9-]*$/.`);
  }
}
