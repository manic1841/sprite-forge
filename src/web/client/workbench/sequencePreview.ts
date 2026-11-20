/**
 * The Composition preview: an open Sequence composition, played back.
 *
 * A composition exists to join footage that was cut apart — often two Clips from
 * two Recordings — so the one thing the preview must show is the **seam**: the
 * boundary where one Clip's last frame meets the next Clip's first, and the wrap
 * from the final frame back to the first. Those are exactly the two places a
 * composition can read wrong, and neither is visible while the Clips sit side by
 * side as ids.
 *
 * The preview is **not** a bake: a Sequence is pure concatenation (Rule 7.1), so
 * playing the source Clips' own sheets back to back is the same pixels commit
 * will tile. Nothing here is stored; the slots are re-read from the composition
 * whenever its Clip list changes.
 *
 * The module owns the `PreviewState` slice and is its only writer, the same way
 * `cutPlayback` owns playback for the cut face.
 */

import type { WorkbenchApi } from '../api.js';
import type { PreviewSlot, SequenceDraft, WorkbenchState } from './state.js';

/** How far a small frame is blown up, in screen px per Canvas px. */
const PREVIEW_SCALE_MAX = 12;

/** What the preview needs from the shell. */
export interface PreviewDeps {
  readonly api: WorkbenchApi;
  readonly state: WorkbenchState;
  readonly regions: { stage: HTMLElement };
  renderStage(): void;
  renderInspector(): void;
  renderContext(): void;
  run(label: string, body: () => Promise<void>): Promise<void>;
  loadDraft(characterId: string, draftId: string): Promise<void>;
  loadAlignment(characterId: string): Promise<void>;
  setMode(mode: WorkbenchState['mode']): void;
  rescan(): Promise<void>;
}

/** The preview's verbs, as the Compose stage sees them. */
export interface SequencePreview {
  /**
   * Bring the slots in line with `draft`, and return the draft when it is the one
   * on screen. The stage calls this on every render; a change of draft or of its
   * Clip list is what actually re-reads.
   */
  sync(draft: SequenceDraft): Promise<void>;
  /** The preview: frame, transport, and the seam track. */
  render(): HTMLElement;
  toggle(): void;
  /** Stop playback and leave the playhead where it is. */
  stop(): void;
  step(delta: number): void;
  /** Put the playhead on a Clip's first frame. */
  seekClip(slot: number): void;
  /**
   * Put the playhead on the frame *before* a seam, so the join can be judged from
   * both sides: the next press of ▶ is the Clip change itself.
   */
  seekSeam(slot: number): void;
  /** Fork the Clip in `slot` to re-align it, holding the slot for its commit. */
  realign(slot: number): void;
  /** Drop everything and stop (leaving the face, committing, closing). */
  clear(): void;
}

/** Create the preview bound to one shell. */
export function createSequencePreview(deps: PreviewDeps): SequencePreview {
  const { api, state } = deps;

  /** The pending tick, if playing. */
  let timer: ReturnType<typeof setTimeout> | null = null;

  // The signature the slots were built from, so a re-render is not a re-read, and
  // a re-read is not a race with a reorder.
  let builtFor = '';

  function signature(draft: SequenceDraft): string {
    const { realign } = state;
    // The fork is part of what the shelves hold: a re-align swaps one slot's
    // source, and its offset/mirror change the pixels without touching the list.
    const live =
      realign && realign.draftId === draft.id
        ? `${realign.slot}:${realign.forkDraftId}:${placementOf(realign.forkDraftId).x},` +
          `${placementOf(realign.forkDraftId).y},${flipOf(realign.forkDraftId) ? 1 : 0}`
        : '-';
    return `${draft.id}\u0000${draft.clips.join('\u0000')}\u0000${live}`;
  }

  /** The pending placement of a fork the preview is standing in for. */
  function placementOf(draftId: string): { x: number; y: number } {
    const entry = state.alignment?.drafts.find((candidate) => candidate.id === draftId);
    return entry?.placementOffset ?? { x: 0, y: 0 };
  }

  function flipOf(draftId: string): boolean {
    const entry = state.alignment?.drafts.find((candidate) => candidate.id === draftId);
    return entry?.flipX === true;
  }

  async function build(draft: SequenceDraft): Promise<void> {
    const { realign } = state;
    const forkSlot = realign && realign.draftId === draft.id ? realign.slot : -1;
    const slots: PreviewSlot[] = await Promise.all(
      draft.clips.map(async (clipId, index) => {
        try {
          // The slot under a live re-align plays the fork instead: what is being
          // adjusted is not committed yet, and the committed sheet would not move.
          if (index === forkSlot && realign) {
            try {
              const fork = await api.readClipDraft(realign.characterId, realign.forkDraftId);
              const count = fork.frameCount;
              const delays = fork.delaysMs;
              return {
                clipId,
                frameCount: count,
                delaysMs: delays.length === 1 ? Array<number>(count).fill(delays[0]!) : [...delays],
                missing: false,
                // The id the fork was *asked for*: it is what the placement is keyed
                // by, whatever the descriptor echoes back.
                draftId: realign.forkDraftId,
              };
            } catch {
              // The fork was just committed and consumed; the Clip it made is what
              // belongs in the slot now, so fall through to the ordinary read.
            }
          }
          const clip = await api.readClip(draft.characterId, clipId);
          const count = clip.meta.frameCount;
          const delays = clip.meta.delaysMs;
          return {
            clipId,
            frameCount: count,
            delaysMs: delays.length === 1 ? Array<number>(count).fill(delays[0]!) : [...delays],
            missing: false,
            draftId: null,
          };
        } catch {
          // One unreadable source must not blank the whole composition: the seam
          // either side of it is still worth seeing.
          return { clipId, frameCount: 1, delaysMs: [100], missing: true, draftId: null };
        }
      }),
    );
    state.previewSlots = slots;
    state.previewDraftId = draft.id;
    state.previewPlaying = false;
    builtFor = signature(draft);
  }

  /** The total frame count across the slots. */
  function total(): number {
    return state.previewSlots.reduce((sum, slot) => sum + slot.frameCount, 0);
  }

  /** The slot holding global frame `frame`. */
  function locate(frame: number): { slot: number; local: number } {
    let rest = frame;
    const slots = state.previewSlots;
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index]!;
      if (rest < slot.frameCount) {
        return { slot: index, local: rest };
      }
      rest -= slot.frameCount;
    }
    const last = Math.max(0, slots.length - 1);
    return { slot: last, local: Math.max(0, (slots[last]?.frameCount ?? 1) - 1) };
  }

  /** The global frame of a slot's first (or, for a seam, last) frame. */
  function firstFrameOf(slot: number): number {
    let sum = 0;
    for (let index = 0; index < slot; index += 1) {
      sum += state.previewSlots[index]?.frameCount ?? 0;
    }
    return sum;
  }

  function repaint(): void {
    deps.renderStage();
    deps.renderContext();
    deps.renderInspector();
  }

  function schedule(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!state.previewPlaying) {
      return;
    }
    const { slot, local } = locate(state.previewFrame);
    const delay = state.previewSlots[slot]?.delaysMs[local] ?? 100;
    timer = setTimeout(() => {
      timer = null;
      const count = total();
      if (count === 0) {
        stop();
        return;
      }
      // The composition commits with `loop: true`, so the wrap back to frame 0 is
      // part of what is being judged — it is a seam too.
      state.previewFrame = (state.previewFrame + 1) % count;
      repaint();
      schedule();
    }, delay);
  }

  function stop(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    state.previewPlaying = false;
  }

  function toggle(): void {
    if (total() === 0) {
      return;
    }
    if (state.previewPlaying) {
      stop();
    } else {
      state.previewPlaying = true;
      repaint();
      schedule();
      return;
    }
    repaint();
  }

  function step(delta: number): void {
    stop();
    const count = total();
    if (count === 0) {
      return;
    }
    // Stepping crosses a seam without pausing: that transition is the point.
    state.previewFrame = Math.max(0, Math.min(count - 1, state.previewFrame + delta));
    repaint();
  }

  function seekClip(slot: number): void {
    stop();
    if (slot < 0 || slot >= state.previewSlots.length) {
      return;
    }
    state.previewFrame = firstFrameOf(slot);
    repaint();
  }

  function seekSeam(slot: number): void {
    stop();
    // A seam at `slot` is the join *into* that slot, so the frame before it is the
    // previous Clip's last frame.
    if (slot <= 0 || slot >= state.previewSlots.length) {
      return;
    }
    state.previewFrame = Math.max(0, firstFrameOf(slot) - 1);
    repaint();
  }

  async function sync(draft: SequenceDraft): Promise<void> {
    if (state.previewDraftId !== null && state.previewDraftId !== draft.id) {
      stop();
      clear();
    }
    const wanted = signature(draft);
    if (wanted === builtFor) {
      return;
    }
    // Claimed before the awaits, so a re-render during the read is not a second
    // read of the same list.
    builtFor = wanted;
    await deps.run('Preview', async () => {
      await build(draft);
      // An edit can shorten the composition under the playhead.
      state.previewFrame = Math.max(0, Math.min(total() - 1, state.previewFrame));
      deps.renderStage();
      deps.renderContext();
    });
  }

  function clear(): void {
    stop();
    state.previewDraftId = null;
    state.previewSlots = [];
    state.previewFrame = 0;
    builtFor = '';
  }

  /**
   * Fork the Clip in `slot` to re-align it, and stay on the composition.
   *
   * Placement is baked, so the adjustment itself happens on a Draft — but it is
   * only ever made *for a seam*, so the composition stays open, the playhead is
   * parked on the frame before that seam, and the slot plays the fork's raw frames
   * with the pending offset applied. The fork's commit takes the slot.
   */
  function realign(slot: number): void {
    const draft = state.sequenceDraft;
    if (!draft) {
      return;
    }
    const clipId = draft.clips[slot];
    if (!clipId) {
      return;
    }
    const previous = state.realign !== null && state.realign.draftId === draft.id ? state.realign : null;
    // Park on the seam *before* the fork is read, so the frame is chosen against
    // the composition as it is now. The join into this Clip comes first; a first
    // Clip has its outgoing join instead.
    const join = joinOf(slot);
    stop();
    // Pressing the Clip already being adjusted just puts the playhead back on its
    // seam — a second fork of the same Clip would have no slot to arrive in.
    if (previous?.slot === slot) {
      state.previewFrame = Math.max(0, Math.min(total() - 1, join));
      deps.renderStage();
      deps.renderInspector();
      return;
    }
    void deps.run(previous === null ? 'Fork to align' : 'Re-target the fork', async () => {
      // A switch drops the fork it replaces. That Draft was never committed, so
      // leaving it behind would strand an `-align` in the Library with nothing
      // pointing at it; the scan is refreshed so its id can be used again.
      if (previous !== null) {
        state.realign = null;
        deps.renderInspector();
        await api
          .discardDraft(previous.characterId, previous.forkDraftId)
          .catch(() => undefined);
        await deps.rescan();
      }
      const forkDraftId = freeForkId(draft.characterId, clipId);
      const forked = await api.forkClip(draft.characterId, clipId, forkDraftId);
      state.realign = {
        characterId: draft.characterId,
        draftId: draft.id,
        slot,
        clipId,
        forkDraftId: forked.id,
        composition: draft,
      };
      // Opening the Draft clears `sequenceDraft`; the held composition is restored
      // right after, so this is still the Compose face and its preview.
      await deps.loadDraft(draft.characterId, forked.id);
      await deps.loadAlignment(draft.characterId);
      state.sequenceDraft = state.realign?.composition ?? draft;
      state.previewFrame = Math.max(0, Math.min(total() - 1, join));
      deps.setMode('compose');
      deps.renderStage();
      deps.renderInspector();
    });
  }

  /** The frame the playhead parks on when `slot` is taken on: its incoming seam. */
  function joinOf(slot: number): number {
    return slot > 0 ? firstFrameOf(slot) - 1 : firstFrameOf(slot + 1) - 1;
  }

  /** The first free `<clip>-align`, `<clip>-align-2`, … fork draft id. */
  function freeForkId(characterId: string, clipId: string): string {
    const taken = new Set(
      state.scan?.characters
        .find((candidate) => candidate.id === characterId)
        ?.drafts.map((candidate) => candidate.id) ?? [],
    );
    // A Clip that is itself a fork keeps one `-align` suffix, not a growing stack.
    const base = `${clipId.replace(/-align(-\d+)?$/, '')}-align`;
    if (!taken.has(base)) {
      return base;
    }
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
    return base;
  }

  // --- the view --------------------------------------------------------------

  function render(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'seq-preview';
    wrap.dataset.sequencePreview = '';

    const totalFrames = total();
    if (totalFrames === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.dataset.sequencePreviewEmpty = '';
      empty.textContent = 'Add a Clip to preview its seams.';
      wrap.appendChild(empty);
      return wrap;
    }

    const frame = Math.max(0, Math.min(totalFrames - 1, state.previewFrame));
    const { slot, local } = locate(frame);
    const current = state.previewSlots[slot]!;
    const liveFork =
      state.realign !== null && state.realign.draftId === state.sequenceDraft?.id
        ? state.realign.forkDraftId
        : null;

    const row = document.createElement('div');
    row.className = 'draft-stage';

    const prev = document.createElement('button');
    prev.className = 'btn ghost';
    prev.dataset.sequencePrev = '';
    prev.textContent = '◀';
    prev.disabled = frame <= 0;
    prev.title = 'Previous frame (crosses a seam)';
    prev.addEventListener('click', () => step(-1));

    const box = document.createElement('div');
    box.className = 'sheet-box seq-frame-box';
    box.dataset.sequenceFrameBox = '';

    const stack = document.createElement('div');
    stack.className = 'seq-frame-stack';
    box.appendChild(stack);

    let activeImage: HTMLImageElement | null = null;
    /** How the active frame is placed: a strip of the Clip, or a Draft frame. */
    let place: { frameCount: number; local: number; offset: { x: number; y: number }; flip: boolean } =
      { frameCount: current.frameCount, local, offset: { x: 0, y: 0 }, flip: false };

    state.previewSlots.forEach((source, index) => {
      if (source.missing) {
        const missing = document.createElement('div');
        missing.className = 'seq-frame-missing';
        missing.dataset.sequenceMissing = source.clipId;
        missing.textContent = `${source.clipId} — sheet unreadable`;
        missing.hidden = index !== slot;
        stack.appendChild(missing);
        return;
      }
      const img = document.createElement('img');
      img.className = 'sheet';
      img.dataset.sequenceSheet = source.clipId;
      img.hidden = index !== slot;
      img.alt = `${source.clipId}, frame ${local}`;
      // The fork's frames are only read while it is still the live fork; once it is
      // committed the slots hold the Clip and this renders the sheet again.
      if (source.draftId !== null && source.draftId === liveFork) {
        // A Draft has one PNG per frame rather than a tiled sheet, and its frame
        // does not carry the pending placement yet — that is applied here, the
        // same way the bake will apply it later.
        const characterId = state.sequenceDraft?.characterId ?? '';
        img.dataset.sequenceDraftFrame = source.draftId;
        img.src = api.frameUrl(characterId, source.draftId, index === slot ? local : 0);
        img.style.width = '100%';
        if (index === slot) {
          place = {
            frameCount: 1,
            local: 0,
            offset: placementOf(source.draftId),
            flip: flipOf(source.draftId),
          };
        }
        // Recorded on the element as well as applied: the transform is in screen
        // pixels and needs layout, but the values are readable as they stand.
        img.dataset.offsetX = String(placementOf(source.draftId).x);
        img.dataset.offsetY = String(placementOf(source.draftId).y);
        img.dataset.flip = String(flipOf(source.draftId));
      } else {
        img.src = api.sheetUrl(state.sequenceDraft?.characterId ?? '', 'clip', source.clipId);
        img.style.width = `${source.frameCount * 100}%`;
        img.style.transform = `translateX(${(-(index === slot ? local : 0) * 100) / source.frameCount}%)`;
      }
      if (index === slot) {
        activeImage = img;
      }
      stack.appendChild(img);
    });

    const next = document.createElement('button');
    next.className = 'btn ghost';
    next.dataset.sequenceNext = '';
    next.textContent = '▶';
    next.disabled = frame >= totalFrames - 1;
    next.title = 'Next frame (crosses a seam)';
    next.addEventListener('click', () => step(1));

    row.append(prev, box, next);
    wrap.appendChild(row);
    scheduleFit(row, box, activeImage, place);

    const counter = document.createElement('p');
    counter.className = 'seq-counter';
    counter.dataset.sequenceCounter = '';
    // The Clip-local index is shown beside the global one: a seam is judged by the
    // frame on each side of it, never by a running total alone.
    counter.textContent = `${current.clipId} · ${local + 1}/${current.frameCount} · frame ${frame + 1}/${totalFrames}`;
    wrap.appendChild(counter);

    wrap.appendChild(track(slot));
    wrap.appendChild(transport(slot));
    return wrap;
  }

  /** The seam track: one reachable label per Clip, with the joins between them. */
  function track(activeSlot: number): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'seq-track';
    strip.dataset.sequenceTrack = '';

    state.previewSlots.forEach((source, index) => {
      if (index > 0) {
        const seam = document.createElement('button');
        seam.className = 'seq-seam';
        seam.dataset.sequenceSeam = String(index);
        seam.textContent = '│';
        seam.title = `Seam ${state.previewSlots[index - 1]?.clipId} → ${source.clipId} — jump to the frame before it`;
        seam.setAttribute('aria-label', seam.title);
        seam.addEventListener('click', () => seekSeam(index));
        strip.appendChild(seam);
      }
      const label = document.createElement('button');
      label.className = 'seq-slot';
      label.dataset.sequenceSeek = String(index);
      label.textContent = source.clipId;
      label.title = `Jump to the first frame of ${source.clipId}`;
      if (index === activeSlot) {
        label.dataset.active = '';
        label.setAttribute('aria-current', 'true');
      }
      label.addEventListener('click', () => seekClip(index));
      strip.appendChild(label);
    });
    return strip;
  }

  /** Play/pause and the two seam jumps around the current Clip. */
  function transport(activeSlot: number): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'seq-transport';

    const play = document.createElement('button');
    play.className = 'btn small';
    play.dataset.sequencePlay = '';
    play.textContent = state.previewPlaying ? '⏸ Pause' : '▶ Play';
    play.setAttribute('aria-pressed', String(state.previewPlaying));
    play.addEventListener('click', () => toggle());

    bar.appendChild(play);

    const before = document.createElement('button');
    before.className = 'btn small ghost';
    before.dataset.sequenceSeamBefore = '';
    before.textContent = '↤ seam in';
    before.disabled = activeSlot <= 0;
    before.title = 'Jump to the frame just before this Clip starts';
    before.addEventListener('click', () => seekSeam(activeSlot));
    bar.appendChild(before);

    const after = document.createElement('button');
    after.className = 'btn small ghost';
    after.dataset.sequenceSeamAfter = '';
    after.textContent = 'seam out ↦';
    after.disabled = activeSlot >= state.previewSlots.length - 1;
    after.title = 'Jump to this Clip’s last frame, just before the next Clip';
    after.addEventListener('click', () => seekSeam(activeSlot + 1));
    bar.appendChild(after);

    const live =
      state.realign !== null && state.realign.draftId === state.sequenceDraft?.id
        ? state.realign
        : null;
    if (live) {
      const adjusting = document.createElement('span');
      adjusting.className = 'muted seq-realigned';
      adjusting.dataset.sequenceAdjusting = '';
      adjusting.textContent = `Adjusting "${live.clipId}" — placement is in the panel`;
      bar.appendChild(adjusting);
      return bar;
    }

    const align = document.createElement('button');
    align.className = 'btn small ghost';
    align.dataset.sequenceAlign = '';
    align.textContent = 'Align…';
    align.title = `Fork ${state.previewSlots[activeSlot]?.clipId} to adjust its placement`;
    align.addEventListener('click', () => realign(activeSlot));
    bar.appendChild(align);

    return bar;
  }

  /**
   * Size the crop window to the room the row actually has, and place the frame in
   * it.
   *
   * The row is a flex child of the preview and already knows how much height is
   * left under the transport; fitting after layout (and again on a window resize)
   * is what keeps the frame inside the stage instead of over the panels under it.
   * A re-aligned Draft frame is additionally shifted by its pending offset and
   * mirrored, in Canvas pixels scaled with the frame.
   */
  function scheduleFit(
    row: HTMLElement,
    box: HTMLElement,
    img: HTMLImageElement | null,
    place: { frameCount: number; local: number; offset: { x: number; y: number }; flip: boolean },
  ): void {
    if (img === null) {
      return;
    }
    const size = (): void => {
      if (!img.naturalWidth || place.frameCount <= 0 || !row.isConnected) {
        return;
      }
      const width = row.clientWidth - 96;
      const height = row.clientHeight;
      const frameWidth = img.naturalWidth / place.frameCount;
      const frameHeight = img.naturalHeight;
      const fitScale =
        width > 0 && height > 0
          ? Math.min(width / frameWidth, height / frameHeight, PREVIEW_SCALE_MAX)
          : 1;
      const scale = Math.max(1, Math.floor(fitScale));
      box.style.width = `${frameWidth * scale}px`;
      box.style.height = `${frameHeight * scale}px`;
      // A sheet strip is stepped by percentage; a Draft frame is placed outright.
      if (img.dataset.sequenceDraftFrame !== undefined) {
        // The mirror flips about the frame's left edge, so the frame is stepped
        // across its own width first — otherwise it would flip out of the box.
        const mirror = place.flip ? ' translateX(100%) scaleX(-1)' : '';
        img.style.transform =
          `translate(${place.offset.x * scale}px, ${place.offset.y * scale}px)${mirror}`;
      }
    };
    requestAnimationFrame(size);
    if (img.complete) {
      size();
    } else {
      img.addEventListener('load', size, { once: true });
    }
    const refit = (): void => {
      if (!box.isConnected) {
        window.removeEventListener('resize', refit);
        return;
      }
      size();
    };
    window.addEventListener('resize', refit);
  }

  return { sync, render, toggle, stop, step, seekClip, seekSeam, realign, clear };
}
