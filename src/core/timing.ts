/**
 * Frame timing of an Asset or an exported animation.
 *
 * A single base duration plus a sparse map of frames that deviate from it. The
 * duration of frame `i` is the total function `overrideMs[i] ?? frameMs`, so the
 * shape is uniform-by-default: the common case stores one number, and only a
 * source that really hiccups (an mGBA capture dropping a frame) pays for a map.
 *
 * The array form arrives from the source (a GIF's per-frame delays) and from the
 * Draft (which is not a frozen format, format-spec §11); the contract stores
 * {@link AssetTiming}. See format-spec §5 Rule 5.1.
 */

/** A timing: one base duration plus the frames that deviate from it. */
export interface AssetTiming {
  /** Base frame duration in ms; every frame without an override uses this. */
  frameMs: number;
  /**
   * Frame index (as a decimal string, per Rule 0.3's closed objects) -> duration.
   * Absent when every frame uses `frameMs`.
   */
  overrideMs?: Record<string, number>;
}

/** A positive integer millisecond value, which both fields require. */
function assertMs(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} must be an integer >= 1; got ${String(value)}.`);
  }
}

/** True when every frame uses the same duration. */
export function isUniform(timing: AssetTiming): boolean {
  return timing.overrideMs === undefined || Object.keys(timing.overrideMs).length === 0;
}

/** The number of frames that deviate from the base duration. */
export function overrideCount(timing: AssetTiming): number {
  return timing.overrideMs === undefined ? 0 : Object.keys(timing.overrideMs).length;
}

/** The duration of one frame: the override when there is one, else the base. */
export function frameDelayMs(timing: AssetTiming, frame: number): number {
  return timing.overrideMs?.[String(frame)] ?? timing.frameMs;
}

/** Expand a timing to one duration per frame (Rule 5.1's readable form). */
export function expandTiming(timing: AssetTiming, frameCount: number): number[] {
  return Array.from({ length: frameCount }, (_unused, frame) => frameDelayMs(timing, frame));
}

/**
 * Collapse per-frame durations to a timing: the **mode** becomes the base and
 * every other frame becomes an override (ties in the mode go to the smallest
 * duration, for determinism). An override equal to the base is dropped, so a
 * uniform input yields no `overrideMs` at all.
 */
export function timingFromDelays(delaysMs: readonly number[]): AssetTiming {
  if (delaysMs.length === 0) {
    throw new RangeError('delaysMs must not be empty.');
  }
  const counts = new Map<number, number>();
  for (const delay of delaysMs) {
    assertMs(delay, 'delay');
    counts.set(delay, (counts.get(delay) ?? 0) + 1);
  }
  let frameMs = delaysMs[0]!;
  let best = 0;
  for (const [delay, count] of counts) {
    if (count > best || (count === best && delay < frameMs)) {
      frameMs = delay;
      best = count;
    }
  }
  const overrideMs: Record<string, number> = {};
  delaysMs.forEach((delay, frame) => {
    if (delay !== frameMs) {
      overrideMs[String(frame)] = delay;
    }
  });
  return Object.keys(overrideMs).length === 0 ? { frameMs } : { frameMs, overrideMs };
}

/**
 * Retime a per-frame duration list to a single rate, preserving the frame count.
 * The mode of the source is the honest choice: it keeps the capture's dominant
 * cadence and drops the hiccups (docs/research/mgba-gif-ingestion.md).
 */
export function normalizeDelays(delaysMs: readonly number[]): number[] {
  const { frameMs } = timingFromDelays(delaysMs);
  return Array.from({ length: delaysMs.length }, () => frameMs);
}

/** Divide every duration by a playback `speed`, rounding and flooring at 1 ms. */
export function scaleTiming(timing: AssetTiming, speed: number): AssetTiming {
  if (speed === 1) {
    return timing;
  }
  const scale = (ms: number): number => Math.max(1, Math.round(ms / speed));
  const frameMs = scale(timing.frameMs);
  if (timing.overrideMs === undefined) {
    return { frameMs };
  }
  const overrideMs: Record<string, number> = {};
  for (const [frame, ms] of Object.entries(timing.overrideMs)) {
    overrideMs[frame] = scale(ms);
  }
  return { frameMs, overrideMs };
}

/** Copy a timing (so a reader cannot mutate a stored one). */
export function copyTiming(timing: AssetTiming): AssetTiming {
  return timing.overrideMs === undefined
    ? { frameMs: timing.frameMs }
    : { frameMs: timing.frameMs, overrideMs: { ...timing.overrideMs } };
}

/**
 * Validate a timing against the frame count it will be played at; returns the
 * problems so both the Draft validator and `validate` can report them the same way.
 * An override index at or beyond `frameCount` is a dangling reference and an
 * error, not a silently ignored entry.
 */
export function timingIssues(
  timing: AssetTiming,
  frameCount: number | undefined,
  path = '',
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  if (!Number.isInteger(timing.frameMs) || timing.frameMs < 1) {
    issues.push({ path: `${path}/frameMs`, message: 'must be an integer >= 1' });
  }
  if (timing.overrideMs === undefined) {
    return issues;
  }
  const frames = Object.keys(timing.overrideMs);
  if (frames.length === 0) {
    issues.push({ path: `${path}/overrideMs`, message: 'must not be empty when present' });
  }
  for (const frame of frames) {
    if (!/^(0|[1-9][0-9]*)$/.test(frame)) {
      issues.push({ path: `${path}/overrideMs/${frame}`, message: 'key must be a decimal frame index' });
      continue;
    }
    const index = Number(frame);
    if (frameCount !== undefined && index >= frameCount) {
      issues.push({
        path: `${path}/overrideMs/${frame}`,
        message: `frame ${index} is outside the frameCount (${frameCount})`,
      });
    }
    assertMsWithin(timing.overrideMs[frame], `${path}/overrideMs/${frame}`, issues);
  }
  return issues;
}

function assertMsWithin(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    issues.push({ path, message: 'must be an integer >= 1' });
  }
}
