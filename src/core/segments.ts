/**
 * `segments` — cut a Recording into named Segments.
 *
 * A **Segment** is a named cut in a Recording's cut list: a half-open frame range
 * `[startFrame, endFrame)` covering one action's worth of footage (GLOSSARY.md).
 * The cut list lives beside the source at `recordings/<recording-id>/cuts.json`
 * and carries the Recording's `hash` and `frameCount` (format-spec §2).
 *
 * Cutting edits **only** the `cuts` array; the recorded `hash` and `frameCount`
 * are preserved so a swapped or truncated source keeps being detected. Editing the
 * cut list changes what future Clips can be generated from; it never disturbs a
 * committed Clip (a Clip snapshots the range it was cut from, Rule 6.1).
 *
 * Only **identity** is enforced (Rule 2.1): cut ids are unique within a Recording.
 * Overlapping and repeated frame ranges are legitimate and are never policed; a
 * `jump` and a shorter `jump-takeoff` may share frames.
 */

import { StoreError } from './errors.js';
import { assertValidId } from './ids.js';
import { cutsPath } from './layout.js';
import { pathExists, readJsonFile, writeJsonFile } from './store/index.js';
import { validateArtifact } from './validate.js';

/** One named cut: a half-open frame range with an optional playback multiplier. */
export interface Segment {
  /** Cut id; unique within the Recording. */
  id: string;
  /** Inclusive first frame of the range. */
  startFrame: number;
  /** Exclusive end of the range; must be `> startFrame`. */
  endFrame: number;
  /** Playback multiplier applied when a Clip is generated. Omitted when `1`. */
  speed?: number;
}

/** A Recording's cut list, exactly as stored in `cuts.json`. */
export interface CutList {
  /** `sha256:` + 64 lowercase hex of the source; detects a swapped source. */
  hash: string;
  /** Frame count of the source; detects a truncated/replaced file. */
  frameCount: number;
  /** The Recording's Segments. */
  cuts: Segment[];
}

/**
 * Read a Recording's cut list back from the store.
 *
 * Read is validated (format-spec §10): a corrupt cut list is a hard error, never
 * warn-and-continue. The verb returns the canonical stored shape so callers edit
 * from what is on disk rather than re-deriving it.
 */
export async function readCutList(root: string, recordingId: string): Promise<CutList> {
  assertValidId(recordingId, 'recording', 'recordingId');
  const artifactPath = cutsPath(recordingId);

  if (!(await pathExists(root, artifactPath))) {
    throw new StoreError(`No Recording "${recordingId}" in the store (${artifactPath} is missing).`);
  }

  const value = await readJsonFile(root, artifactPath);
  validateArtifact('cuts', value, { artifact: artifactPath });
  return value as CutList;
}

/** Inputs for {@link addSegment}. */
export interface AddSegmentOptions {
  recordingId: string;
  /** Cut id; unique within the Recording. */
  id: string;
  /** Inclusive first frame of the range. */
  startFrame: number;
  /** Exclusive end of the range; must be `> startFrame` and `<= frameCount`. */
  endFrame: number;
  /** Playback multiplier; omitted from the artifact when `1`. */
  speed?: number;
}

/** Add a Segment to a Recording's cut list, returning the updated cut list. */
export async function addSegment(root: string, options: AddSegmentOptions): Promise<CutList> {
  assertValidId(options.recordingId, 'recording', 'recordingId');
  assertValidId(options.id, 'cut', 'cut id');

  const cutList = await readCutList(root, options.recordingId);
  const segment = makeSegment(options);
  const next = withCuts(cutList, [...cutList.cuts, segment]);
  await writeCutList(root, options.recordingId, next);
  return next;
}

/**
 * Build one Segment, omitting `speed` when it is `1` (format-spec §2). The range
 * is stored verbatim: `speed` is a playback multiplier and never rewrites frames.
 */
function makeSegment(options: {
  id: string;
  startFrame: number;
  endFrame: number;
  speed?: number;
}): Segment {
  const segment: Segment = {
    id: options.id,
    startFrame: options.startFrame,
    endFrame: options.endFrame,
  };
  if (options.speed !== undefined && options.speed !== 1) {
    segment.speed = options.speed;
  }
  return segment;
}

/** Inputs for {@link renameSegment}. */
export interface RenameSegmentOptions {
  recordingId: string;
  /** The existing cut id to rename. */
  id: string;
  /** The new cut id; must not collide with another Segment in the Recording. */
  newId: string;
}

/** Rename a Segment's cut id, returning the updated cut list. */
export async function renameSegment(
  root: string,
  options: RenameSegmentOptions,
): Promise<CutList> {
  assertValidId(options.recordingId, 'recording', 'recordingId');
  assertValidId(options.id, 'cut', 'cut id');
  assertValidId(options.newId, 'cut', 'cut id');

  const cutList = await readCutList(root, options.recordingId);
  const index = cutList.cuts.findIndex((cut) => cut.id === options.id);
  if (index === -1) {
    throw new StoreError(
      `No Segment "${options.id}" in Recording "${options.recordingId}".`,
    );
  }

  const cuts = cutList.cuts.map((cut, at) => (at === index ? { ...cut, id: options.newId } : cut));
  const next = withCuts(cutList, cuts);
  await writeCutList(root, options.recordingId, next);
  return next;
}

/** Inputs for {@link removeSegment}. */
export interface RemoveSegmentOptions {
  recordingId: string;
  /** The cut id to remove. */
  id: string;
}

/** Remove a Segment from a Recording's cut list, returning the updated cut list. */
export async function removeSegment(
  root: string,
  options: RemoveSegmentOptions,
): Promise<CutList> {
  assertValidId(options.recordingId, 'recording', 'recordingId');
  assertValidId(options.id, 'cut', 'cut id');

  const cutList = await readCutList(root, options.recordingId);
  if (!cutList.cuts.some((cut) => cut.id === options.id)) {
    throw new StoreError(
      `No Segment "${options.id}" in Recording "${options.recordingId}".`,
    );
  }

  const cuts = cutList.cuts.filter((cut) => cut.id !== options.id);
  const next = withCuts(cutList, cuts);
  await writeCutList(root, options.recordingId, next);
  return next;
}

/** Inputs for {@link setSegmentRange}. */
export interface SetSegmentRangeOptions {
  recordingId: string;
  /** The cut id whose range is retargeted. */
  id: string;
  /** Inclusive first frame of the new range. */
  startFrame: number;
  /** Exclusive end of the new range; must be `> startFrame` and `<= frameCount`. */
  endFrame: number;
}

/**
 * Retarget an existing Segment to a new half-open frame range, returning the
 * updated cut list. The cut id and its `speed` are kept; only the range moves.
 * Dragging a range edge in the web timeline lands here. The new range is checked
 * against the same rules as {@link addSegment}: an empty or out-of-bounds range
 * fails validation and writes nothing.
 */
export async function setSegmentRange(
  root: string,
  options: SetSegmentRangeOptions,
): Promise<CutList> {
  assertValidId(options.recordingId, 'recording', 'recordingId');
  assertValidId(options.id, 'cut', 'cut id');

  const cutList = await readCutList(root, options.recordingId);
  const index = cutList.cuts.findIndex((cut) => cut.id === options.id);
  if (index === -1) {
    throw new StoreError(
      `No Segment "${options.id}" in Recording "${options.recordingId}".`,
    );
  }

  const cuts = cutList.cuts.map((cut, at) =>
    at === index
      ? { ...cut, startFrame: options.startFrame, endFrame: options.endFrame }
      : cut,
  );
  const next = withCuts(cutList, cuts);
  await writeCutList(root, options.recordingId, next);
  return next;
}

/** A new cut list carrying the same `hash` and `frameCount`, with cuts in frame order. */
function withCuts(cutList: CutList, cuts: Segment[]): CutList {
  return {
    hash: cutList.hash,
    frameCount: cutList.frameCount,
    cuts: [...cuts].sort((a, b) => a.startFrame - b.startFrame),
  };
}

/** Validate the cut list as a whole, then persist it. A failed write is a hard error. */
async function writeCutList(root: string, recordingId: string, cutList: CutList): Promise<void> {
  const artifactPath = cutsPath(recordingId);
  validateArtifact('cuts', cutList, { artifact: artifactPath });
  await writeJsonFile(root, artifactPath, cutList);
}
