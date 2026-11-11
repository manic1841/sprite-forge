/**
 * Playback preview for the cut face.
 *
 * Play previews the Segment at the playhead — the frames its drag handles span —
 * and steps the Recording's own `delaysMs`, so what is previewed is that cut at
 * the capture's real timing. It is a *pause*-style toggle: stopping leaves the
 * frame where it is.
 */

import type { Segment } from '../types.js';
import type { WorkbenchState } from './state.js';

/** Fallback delay for a Recording whose source reports none. */
const DEFAULT_DELAY_MS = 100;

/** What playback needs: the state, the playhead painter, the toggle painter. */
export interface PlaybackDeps {
  readonly state: WorkbenchState;
  /** Move the playhead and repaint it in place (no strip rebuild). */
  showFrame(index: number): void;
  /** Repaint the play toggle in place. */
  playStateChanged(): void;
  /** The Segment covering a frame, for resolving the range. */
  segmentAt(frame: number): Segment | null;
}

/** The preview verbs the session re-exports. */
export interface Playback {
  /** Start or pause previewing the range under the playhead. */
  toggle(): void;
  /** Stop advancing and leave the frame where it is. Safe without a render. */
  stop(): void;
}

/** Create the preview bound to one session. */
export function createPlayback(deps: PlaybackDeps): Playback {
  const { state } = deps;

  /** The pending tick, if playing. */
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The half-open frame range playback is confined to for the current run.
   *
   * It is fixed when playback starts so a re-cut mid-play cannot move the finish
   * line.
   */
  let range: { startFrame: number; endFrame: number } | null = null;

  /**
   * The half-open range playback should preview.
   *
   * A marked range comes first: it is a cut being previewed before it exists,
   * which is the whole point of marking one. Otherwise the playhead *is* the
   * selection, so the range is the Segment it sits in; outside every Segment
   * (frame 0 of a freshly cut capture is the common case) it is the next Segment
   * after it, else the last one — Play previews a cut, never the surrounding
   * footage. Only an uncut Recording has no Segment, and then it plays whole.
   */
  function rangeFor(): { startFrame: number; endFrame: number } | null {
    const frameCount = state.cutList?.frameCount ?? 0;
    if (frameCount === 0) {
      return null;
    }
    if (state.selection) {
      return state.selection;
    }
    const cuts = state.cutList?.cuts ?? [];
    const segment =
      deps.segmentAt(state.frame) ??
      cuts.find((cut) => cut.endFrame > state.frame) ??
      cuts[cuts.length - 1];
    return segment
      ? { startFrame: segment.startFrame, endFrame: segment.endFrame }
      : { startFrame: 0, endFrame: frameCount };
  }

  /**
   * Play the range resolved for the playhead.
   *
   * A playhead outside that range rewinds to its first frame, so Play always
   * previews the same whole cut; at its end it replays from the start.
   */
  function play(): void {
    const next = rangeFor();
    if (!next) {
      return;
    }
    stop();
    range = next;

    if (state.frame >= range.endFrame - 1 || state.frame < range.startFrame) {
      deps.showFrame(range.startFrame);
    }
    state.playing = true;
    schedule();
  }

  /** Queue the next frame after *its own* delay, so timing is the capture's. */
  function schedule(): void {
    const delay = state.recordingDelaysMs[state.frame] ?? DEFAULT_DELAY_MS;
    timer = setTimeout(tick, delay);
  }

  function tick(): void {
    timer = null;
    // Playback only means something while the Recording is still the open target.
    if (state.target.kind !== 'recording' || !range) {
      stop();
      deps.playStateChanged();
      return;
    }
    if (state.frame >= range.endFrame - 1) {
      stop();
      deps.playStateChanged();
      return;
    }
    deps.showFrame(state.frame + 1);
    schedule();
  }

  function stop(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    range = null;
    state.playing = false;
  }

  function toggle(): void {
    if (state.playing) {
      stop();
    } else {
      play();
    }
    deps.playStateChanged();
  }

  return { toggle, stop };
}
