/**
 * The cut session: one Recording, its playhead, its marked range and its cuts.
 *
 * This is the deep module behind cutting. The filmstrip and the cut face only
 * build DOM; every rule about a range lives here — that a mark and a selected
 * cut never stand at once, that a drag clamps, that releasing an edge persists.
 * Callers get a small verb set and never touch the rules.
 *
 * Three jobs have their own module and the session composes them: the Character
 * ask (`cutTargets`), the preview (`cutPlayback`) and Extract
 * (`extractSegment`). The session keeps only the range itself.
 *
 * The session owns the `CutState` slice and is its only writer.
 */

import type { WorkbenchApi } from '../api.js';
import { clampRange } from '../timeline.js';
import type { Bounds, Segment } from '../types.js';
import { confirmAction, promptText } from './dialog.js';
import { createPlayback } from './cutPlayback.js';
import { askCharacterTarget, createCharacterFramedFrom, type CutTargetDeps } from './cutTargets.js';
import { extractSegment } from './extractSegment.js';
import type { WorkbenchState } from './state.js';

/** What a session needs from the shell: state, store, and targeted repaints. */
export interface CutSessionDeps extends CutTargetDeps {
  readonly state: WorkbenchState;
  /** The regions a range paints into (rail marks, strip, stage preview). */
  readonly regions: { rail: HTMLElement; stage: HTMLElement; filmstrip: HTMLElement };
  /** Repaint only what a step changed. */
  render: {
    library(): void;
    stage(): void;
    filmstrip(): void;
    inspector(): void;
    context(): void;
  };
  /** Run a user action, surfacing a rejection as visible state. */
  run(label: string, body: () => Promise<void>): void;
  /** Move the playhead and repaint it in place (no strip rebuild). */
  showFrame(index: number): void;
  /** Repaint the play toggle in place. */
  playStateChanged(): void;
  /** Stop playback (the session's own stop, reachable from detached controls). */
  stop(): void;
  loadDraft(characterId: string, draftId: string): Promise<void>;
  loadRecording(recordingId: string): Promise<void>;
}

/** The cut verbs a view may call. */
export interface CutSession {
  /** The Segment covering `frame`, if any. */
  segmentAt(frame: number): Segment | null;
  /** Whether `frame` lies in any Segment. */
  inRange(frame: number): boolean;
  /** Select the Segment a user scrubbed into (clears a mark when they land in one). */
  scrubTo(index: number): void;
  /** Select a stored Segment for editing and take the playhead to it. */
  selectSegment(segment: Segment): void;
  /** Repaint the selected Segment's rail rows without rebuilding the rail. */
  paintMarks(): void;
  /** Start a new range at the pressed point and follow the pointer. */
  beginPick(track: HTMLElement, down: PointerEvent): void;
  /** Drag a stored Segment's edge; releasing persists the clamped range. */
  startTrim(
    handle: HTMLElement,
    edge: 'start' | 'end',
    cut: Segment,
    range: HTMLElement,
    event: PointerEvent,
  ): void;
  /** Draw a Segment's source box on the stage; releasing persists it. */
  beginBox(cutId: string, frame: HTMLElement, event: PointerEvent): void;
  /** Persist a Segment's box, or clear it when `rect` is `null`. */
  setBox(cutId: string, rect: Bounds | null): Promise<void>;
  /** Fill the box with the Segment's own content bounds, widened to at least 1×1. */
  boxContent(cutId: string): Promise<void>;
  /** Keep the marked range as a Segment, asking for its name and Character. */
  saveSelection(): Promise<void>;
  /** Extract a Segment into its Character, repairing the framing if needed. */
  extract(cutId: string): Promise<boolean>;
  /** Rename a stored Segment. */
  rename(cutId: string): Promise<void>;
  /** Delete a stored Segment, behind a confirmation. */
  remove(cutId: string): Promise<void>;
  /** Start or pause previewing the range under the playhead. */
  togglePlayback(): void;
  /** Stop playback and leave the playhead where it is. */
  stop(): void;
}

/** Create the session bound to one shell. */
export function createCutSession(deps: CutSessionDeps): CutSession {
  const { api, state, regions, render } = deps;

  const playback = createPlayback({
    state,
    showFrame: deps.showFrame,
    playStateChanged: deps.playStateChanged,
    segmentAt: (frame) => segmentAt(frame),
  });

  function segmentAt(frame: number): Segment | null {
    return (
      state.cutList?.cuts.find((cut) => frame >= cut.startFrame && frame < cut.endFrame) ?? null
    );
  }

  function inRange(frame: number): boolean {
    return segmentAt(frame) !== null;
  }

  function scrubTo(index: number): void {
    playback.stop();
    // Landing in a Segment is an edit of it, and editing replaces marking.
    const covering = segmentAt(index);
    if (covering) {
      state.selectedCut = covering.id;
      state.selection = null;
    }
    deps.showFrame(index);
  }

  function selectSegment(segment: Segment): void {
    playback.stop();
    state.selectedCut = segment.id;
    // Editing a Segment replaces marking a range: the two never stand at once, so
    // Play has one unambiguous target.
    state.selection = null;
    state.frame = segment.startFrame;
    paintMarks();
    render.stage();
    render.filmstrip();
    render.context();
    render.inspector();
  }

  function paintMarks(): void {
    for (const row of regions.rail.querySelectorAll<HTMLElement>('[data-segment]')) {
      row.classList.toggle('sel', row.dataset.segment === state.selectedCut);
    }
  }

  // --- marking --------------------------------------------------------------

  function beginPick(track: HTMLElement, down: PointerEvent): void {
    const frameCount = state.cutList?.frameCount ?? 0;
    playback.stop();
    // Marking replaces editing: leaving a Segment selected next to a fresh range
    // is what made Play pick the wrong thing. The strip is rebuilt so the dropped
    // Segment's handles go with it; the gesture then runs against the new track.
    const restore = state.selection;
    state.selectedCut = null;
    paintMarks();
    render.filmstrip();

    const frameAt = (clientX: number): number => {
      // Re-read the track: the rebuild above replaced the node the press landed on.
      const live = regions.filmstrip.querySelector<HTMLElement>('[data-pick]') ?? track;
      const rect = live.getBoundingClientRect();
      const raw = Math.floor(((clientX - rect.left) / rect.width) * frameCount);
      return Math.max(0, Math.min(frameCount - 1, raw));
    };

    const anchor = frameAt(down.clientX);
    const paint = (cursor: number): void => {
      const [start, end] = anchor <= cursor ? [anchor, cursor] : [cursor, anchor];
      state.selection = { startFrame: start, endFrame: end + 1 };
      paintSelection();
    };
    paint(anchor);

    const finish = (persist: boolean): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      if (!persist) {
        state.selection = restore;
        render.filmstrip();
        render.inspector();
        return;
      }
      // Land on the range's first frame and let the inspector show it as a cut to
      // come: the selection is confirmed by playing it, then saved.
      if (state.selection) {
        deps.showFrame(state.selection.startFrame);
        paintSelection();
      }
    };
    const move = (moveEvent: PointerEvent): void => paint(frameAt(moveEvent.clientX));
    const up = (): void => finish(true);
    const cancel = (): void => finish(false);
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
  }

  function paintSelection(): void {
    const track = regions.filmstrip.querySelector<HTMLElement>('[data-pick]');
    const selection = state.selection;
    if (!track || !selection) {
      return;
    }
    const frameCount = state.cutList?.frameCount ?? 1;
    let band = track.querySelector<HTMLElement>('[data-pick-band]');
    if (!band) {
      band = document.createElement('span');
      band.className = 'pick-band sel';
      band.dataset.pickBand = '';
      track.appendChild(band);
    }
    band.style.left = `${(selection.startFrame / frameCount) * 100}%`;
    band.style.width = `${((selection.endFrame - selection.startFrame) / frameCount) * 100}%`;

    // The verbs are only in the header when a range existed at render time; a drag
    // that starts from nothing brings them in itself rather than re-rendering
    // mid-gesture.
    const controls = regions.filmstrip.querySelector<HTMLElement>('[data-filmstrip-controls]');
    if (!controls) {
      return;
    }
    let group = controls.querySelector<HTMLElement>('[data-pick-actions]');
    if (!group) {
      group = renderSelectionActions(deps);
      controls.insertBefore(group, controls.querySelector('[data-recording-play]'));
    }
    const label = group.querySelector<HTMLElement>('[data-pick-label]');
    if (label) {
      label.textContent = rangeLabel(selection);
    }
  }

  function startTrim(
    handle: HTMLElement,
    edge: 'start' | 'end',
    cut: Segment,
    range: HTMLElement,
    event: PointerEvent,
  ): void {
    event.preventDefault();
    const track = handle.parentElement!.parentElement!;
    const rect = track.getBoundingClientRect();
    const frameCount = state.cutList?.frameCount ?? 1;
    const frameAt = (clientX: number): number =>
      Math.round(((clientX - rect.left) / rect.width) * frameCount);

    const paint = (next: { startFrame: number; endFrame: number }): void => {
      range.style.left = `${(next.startFrame / frameCount) * 100}%`;
      range.style.width = `${((next.endFrame - next.startFrame) / frameCount) * 100}%`;
    };
    const settle = (clientX: number): { startFrame: number; endFrame: number } =>
      clampRange(edge, frameAt(clientX), cut, frameCount);

    const finish = (persist: boolean, clientX = 0): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      if (!persist) {
        paint(cut);
        return;
      }
      const next = settle(clientX);
      deps.run('Re-cut segment', () => persistRange(cut.id, next.startFrame, next.endFrame));
    };

    const move = (moveEvent: PointerEvent): void => paint(settle(moveEvent.clientX));
    const up = (upEvent: PointerEvent): void => finish(true, upEvent.clientX);
    const cancel = (): void => finish(false);
    const key = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault();
        finish(false);
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
  }

  async function persistRange(
    cutId: string,
    startFrame: number,
    endFrame: number,
  ): Promise<void> {
    if (!state.recordingId) {
      return;
    }
    state.cutList = await api.setSegmentRange(state.recordingId, cutId, startFrame, endFrame);
    render.filmstrip();
    render.inspector();
  }

  // --- the box --------------------------------------------------------------

  /**
   * Draw the source box: press at one corner, release at the other.
   *
   * A Segment is one piece of footage, so its time range and its window are
   * edited side by side. The drag stays inside the frame, and a press without
   * movement still leaves a 1x1 box rather than nothing to see. Releasing writes
   * the box; the stage reads it off the cut, so nothing is held here.
   */
  function beginBox(cutId: string, frame: HTMLElement, down: PointerEvent): void {
    down.preventDefault();
    const img = frame.querySelector<HTMLImageElement>('[data-recording-frame]');
    if (!img) {
      return;
    }
    const origin = boxPoint(down, img);
    const ghost = frame.querySelector<HTMLElement>('[data-cut-box-ghost]');
    const paint = (rect: Bounds): void => {
      if (!ghost) {
        return;
      }
      const size = sourceSize(img);
      ghost.hidden = false;
      ghost.dataset.box = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      ghost.style.left = `${(rect.x / size.width) * 100}%`;
      ghost.style.top = `${(rect.y / size.height) * 100}%`;
      ghost.style.width = `${(rect.width / size.width) * 100}%`;
      ghost.style.height = `${(rect.height / size.height) * 100}%`;
    };
    const settle = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      if (ghost) {
        ghost.hidden = true;
      }
    };

    const move = (event: PointerEvent): void => {
      const to = boxPoint(event, img);
      paint(boxBetween(origin, to, sourceSize(img)));
    };
    const up = (event: PointerEvent): void => {
      settle();
      const to = boxPoint(event, img);
      void setBox(cutId, boxBetween(origin, to, sourceSize(img)));
    };
    const cancel = (): void => {
      settle();
      render.stage();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    };

    paint(boxBetween(origin, origin, sourceSize(img)));
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
  }

  async function setBox(cutId: string, rect: Bounds | null): Promise<void> {
    const recordingId = state.recordingId;
    if (!recordingId) {
      return;
    }
    state.cutList = await api.setSegmentRect(recordingId, cutId, rect);
    render.stage();
    render.inspector();
  }

  /**
   * Fill the box with the Segment's content.
   *
   * Extraction measures a keyed frame, so a box drawn against pixels the key
   * cannot remove is only a starting point; this snaps it to what actually
   * survives, and is also the "tighten" on an existing box. A Segment that draws
   * nothing has nothing to offer and says so rather than writing an empty box.
   */
  async function boxContent(cutId: string): Promise<void> {
    const recordingId = state.recordingId;
    if (!recordingId) {
      return;
    }
    const bounds = await api.segmentContentBounds(recordingId, cutId);
    if (bounds === null) {
      throw new Error('This Segment draws nothing; there is no content to box.');
    }
    // The box must be at least one pixel, which a single-pixel subject satisfies
    // only if the union is widened to the same 1x1 floor.
    await setBox(cutId, {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(bounds.width, 1),
      height: Math.max(bounds.height, 1),
    });
  }

  // --- saving ---------------------------------------------------------------

  async function saveSelection(): Promise<void> {
    await saveMarked(deps);
  }

  async function rename(cutId: string): Promise<void> {
    const recordingId = state.recordingId;
    if (!recordingId) {
      return;
    }
    const next = await promptText(`Rename segment "${cutId}" to:`, cutId, 'Rename');
    if (next === null || next === '' || next === cutId) {
      return;
    }
    state.cutList = await api.renameSegment(recordingId, cutId, next);
    // Follow the cut to its new id, so the inspector keeps editing the same one.
    if (state.selectedCut === cutId) {
      state.selectedCut = next;
    }
    render.library();
    render.stage();
    render.filmstrip();
    render.inspector();
  }

  async function remove(cutId: string): Promise<void> {
    const recordingId = state.recordingId;
    if (!recordingId) {
      return;
    }
    // Deleting a Segment is not undoable, so it asks first.
    if (!(await confirmAction(`Delete segment "${cutId}"?`, 'Delete'))) {
      return;
    }
    state.cutList = await api.removeSegment(recordingId, cutId);
    if (state.selectedCut === cutId) {
      state.selectedCut = null;
    }
    render.library();
    render.stage();
    render.filmstrip();
    render.inspector();
  }

  async function extract(cutId: string): Promise<boolean> {
    return await extractSegment(deps, cutId);
  }

  return {
    segmentAt,
    inRange,
    scrubTo,
    selectSegment,
    paintMarks,
    beginPick,
    startTrim,
    saveSelection,
    extract,
    rename,
    remove,
    beginBox,
    setBox,
    boxContent,
    togglePlayback: playback.toggle,
    stop: playback.stop,
  };
}

/** The frame's own pixel size, falling back to its laid-out box while it decodes. */
function sourceSize(img: HTMLImageElement): { width: number; height: number } {
  const rect = img.getBoundingClientRect();
  return {
    width: img.naturalWidth || Math.max(1, Math.round(rect.width)),
    height: img.naturalHeight || Math.max(1, Math.round(rect.height)),
  };
}

/** The source pixel under a pointer event. */
function boxPoint(event: PointerEvent, img: HTMLImageElement): { x: number; y: number } {
  const rect = img.getBoundingClientRect();
  const size = sourceSize(img);
  return {
    x: Math.floor(((event.clientX - rect.left) / (rect.width || 1)) * size.width),
    y: Math.floor(((event.clientY - rect.top) / (rect.height || 1)) * size.height),
  };
}

/**
 * The box between two dragged corners, clamped to the frame and inclusive of both
 * endpoints, so a press with no movement still describes one pixel.
 */
function boxBetween(
  from: { x: number; y: number },
  to: { x: number; y: number },
  size: { width: number; height: number },
): Bounds {
  const clampX = (value: number): number => Math.min(Math.max(value, 0), size.width - 1);
  const clampY = (value: number): number => Math.min(Math.max(value, 0), size.height - 1);
  const x1 = clampX(from.x);
  const y1 = clampY(from.y);
  const x2 = clampX(to.x);
  const y2 = clampY(to.y);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1) + 1,
    height: Math.abs(y2 - y1) + 1,
  };
}

/** `frames 1–3` — what the selection covers, in inclusive human terms. */
export function rangeLabel(selection: { startFrame: number; endFrame: number }): string {
  const last = selection.endFrame - 1;
  return selection.startFrame === last
    ? `frame ${last}`
    : `frames ${selection.startFrame}–${last}`;
}

/**
 * The actions a marked range offers: confirm it with Play, then keep it.
 *
 * Built here rather than in the filmstrip because a drag that starts from
 * nothing has to insert the same group mid-gesture.
 */
export function renderSelectionActions(deps: CutSessionDeps): HTMLElement {
  const { state } = deps;
  const group = document.createElement('span');
  group.className = 'filmstrip-selection';
  group.dataset.pickActions = '';
  const label = document.createElement('span');
  label.className = 'muted';
  label.dataset.pickLabel = '';
  label.textContent = state.selection ? rangeLabel(state.selection) : '';

  const save = document.createElement('button');
  save.className = 'dock-btn';
  save.type = 'button';
  save.dataset.pickSave = '';
  save.textContent = '✂';
  save.setAttribute('aria-label', 'Save the marked frames as a Segment');
  save.title = 'Save the marked frames as a Segment';
  save.addEventListener('click', () => {
    deps.stop();
    deps.run('Add segment', () => saveMarked(deps));
  });

  const cancel = document.createElement('button');
  cancel.className = 'dock-btn ghost';
  cancel.type = 'button';
  cancel.dataset.pickCancel = '';
  cancel.textContent = '✕';
  cancel.setAttribute('aria-label', 'Clear the marked frames');
  cancel.title = 'Clear the marked frames';
  cancel.addEventListener('click', () => {
    deps.stop();
    deps.state.selection = null;
    deps.render.filmstrip();
    deps.render.inspector();
  });

  group.append(label, save, cancel);
  return group;
}

/** Kept as a free function so the built group can call it without a session reference. */
async function saveMarked(deps: CutSessionDeps): Promise<void> {
  const { state, api } = deps;
  const recordingId = state.recordingId;
  const selection = state.selection;
  if (recordingId === null || !selection) {
    return;
  }
  const suggested = `cut-${(state.cutList?.cuts.length ?? 0) + 1}`;
  const id = (
    await promptText(
      `Name the Segment for frames ${selection.startFrame}–${selection.endFrame - 1}:`,
      suggested,
      'Save Segment',
    )
  )?.trim();
  if (!id) {
    return;
  }

  // The owner is picked among the Characters that exist, or named as a new one. A
  // new Character is framed from this cut, so its id is asked before the cut is
  // written but created after — the framing reads the stored range.
  const target = await askCharacterTarget(
    deps,
    `Save "${id}" for which Character?`,
    'Save Segment',
    'New Character id:',
  );
  if (target === null) {
    return;
  }

  state.cutList = await api.addSegment(recordingId, {
    id,
    startFrame: selection.startFrame,
    endFrame: selection.endFrame,
  });
  state.selection = null;
  state.selectedCut = id;
  state.frame = selection.startFrame;

  if (target.newId === null) {
    state.extractCharacterId = target.characterId;
  } else {
    await createCharacterFramedFrom(deps, recordingId, id, target.newId);
    await deps.rescan();
  }

  deps.render.library();
  deps.render.stage();
  deps.render.filmstrip();
  deps.render.context();
  deps.render.inspector();
}
