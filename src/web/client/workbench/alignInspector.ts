/**
 * The inspector for **Alignment**: placement offsets, the Canvas size (either
 * direction, down to the drawn content), the framing from footage, and what is
 * already placed.
 *
 * The offset edit targets the active Draft (a committed Clip is immutable — fork
 * it to change its offset); committed Clips' offsets are shown read-only.
 */

import type { AlignInspectorPort } from './ports.js';
import { addRow, labeled, make, numberInput, subheading } from './dom.js';
import { confirmAction } from './dialog.js';
import { activeDraft } from './state.js';
import type { Canvas, ContentFloor, PlacementOffset } from '../types.js';

/**
 * Pending offset write.
 *
 * The offset inputs fire on every keystroke. Writing each one straight through
 * meant two overlapping read-modify-write calls, and the second one saved a
 * `draft.json` the first was still writing. A short debounce collapses a burst of
 * typing into one write.
 */
let offsetTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * What this face's placement wants from the section.
 *
 * The Canvas is the Character's, not the Clip's, so a face that is about one Clip
 * relative to another (a composition's seam) leaves the resize behind rather than
 * filling the panel with a decision that belongs to the Character.
 */
export interface AlignSectionOptions {
  /** Render the Canvas size controls. Defaults to on. */
  canvas?: boolean;
}

export function alignInspector(
  ctx: AlignInspectorPort,
  actions: HTMLElement,
  info: HTMLElement,
  options: AlignSectionOptions = {},
): void {
  const { state } = ctx;
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'alignment';
  section.appendChild(subheading('Placement'));

  if (!state.alignment) {
    section.appendChild(make('p', 'muted', 'Select a Character or asset to align.'));
    info.appendChild(section);
    return;
  }

  // A committed Asset is a snapshot: its offset is shown, never edited here. The
  // way to move it is a fork, which is offered in place of the inputs so the
  // reader does not go looking for a control that is deliberately missing.
  const assetTarget = state.target.kind === 'asset' ? state.target : null;
  const draft = activeDraft(state);
  if (assetTarget) {
    showAssetPlacement(ctx, section, assetTarget.characterId, assetTarget.assetKind, assetTarget.assetId);
  } else if (draft && draft.characterId === state.activeCharacterId) {
    // A fork taken from a composition preview is here for one reason — its seam —
    // and committing it puts it back in that slot rather than leaving it as an
    // Asset of its own.
    const realign = state.realign;
    if (realign && realign.forkDraftId === draft.draftId) {
      const note = make(
        'p',
        'muted',
        `Re-aligning "${realign.clipId}" for the composition. Commit this Draft and ` +
          'its slot takes the new Clip.',
      );
      note.dataset.alignForComposition = '';
      section.appendChild(note);
      section.appendChild(targetPicker(ctx, realign.slot));
    }
    const offset = currentDraftOffset(ctx);
    const x = numberInput(offset.x, 'x', () => scheduleOffset(ctx));
    x.dataset.alignOffsetX = '';
    const y = numberInput(offset.y, 'y', () => scheduleOffset(ctx));
    y.dataset.alignOffsetY = '';
    const row = make('div', 'align-offsets');
    row.append(labeled('Offset x', x), labeled('Offset y', y));
    section.appendChild(row);

    const apply = make('button', 'btn small', 'Set offset');
    apply.dataset.alignApply = '';
    apply.addEventListener('click', () => {
      // An explicit click flushes whatever is pending rather than racing it.
      ctx.run('Set offset', () => {
        offsetTimer = null;
        return applyOffset(ctx, currentDraftOffset(ctx));
      });
    });
    section.appendChild(apply);

    // The mirror sits below the offset because it is the other placement change a
    // Draft can carry, but it applies on its own change — a checkbox needs no
    // "set" button. It is a flag on the Draft, applied at bake, not baked pixels,
    // so toggling it never invalidates the Repair script.
    const mirror = make('label', 'choice align-mirror');
    const flip = document.createElement('input');
    flip.type = 'checkbox';
    flip.dataset.alignFlip = '';
    flip.checked = currentDraftFlip(ctx);
    flip.addEventListener('change', () => {
      ctx.run('Mirror x', () => applyFlip(ctx, flip.checked));
    });
    mirror.append(flip, make('span', undefined, 'Mirror x'));
    section.appendChild(mirror);
  } else {
    section.appendChild(
      make('p', 'muted', 'Select a Draft to edit its placement offset (fork an Asset to edit it).'),
    );
  }

  if (!assetTarget && options.canvas !== false) {
    const floor = state.alignment.contentFloor;
    const canvas = state.alignment.canvas;
    const resizeRow = make('div', 'align-size');
    const width = numberInput(state.resizeWidth, 'width', (value) => {
      state.resizeWidth = value;
      syncResize();
    });
    width.dataset.resizeWidth = '';
    width.min = String(floor.width);
    const height = numberInput(state.resizeHeight, 'height', (value) => {
      state.resizeHeight = value;
      syncResize();
    });
    height.dataset.resizeHeight = '';
    height.min = String(floor.height);
    resizeRow.append(labeled('Width', width), labeled('Height', height));
    section.appendChild(resizeRow);

    // Shrinking is allowed down to the drawn content only, so the floor is named
    // rather than left to a rejected save. With nothing drawn, any size is fine.
    const hintBase = !floor.hasContent
      ? 'nothing drawn yet — any size'
      : floor.width === canvas.width && floor.height === canvas.height
        ? 'at the smallest size the content allows'
        : `smallest the content allows: ${floor.width}×${floor.height}`;
    const hint = make('p', 'muted align-floor');
    hint.dataset.alignFloor = `${floor.width}x${floor.height}`;
    hint.textContent = hintBase;
    section.appendChild(hint);

    const resize = make('button', 'btn small', 'Resize canvas') as HTMLButtonElement;
    resize.dataset.resizeCanvasAction = '';
    resize.addEventListener('click', () => ctx.run('Resize canvas', () => applyResize(ctx)));
    section.appendChild(resize);

    const fit = make('button', 'btn small ghost', 'Fit to content') as HTMLButtonElement;
    fit.dataset.fitCanvasAction = '';
    fit.addEventListener('click', () => ctx.run('Fit canvas', () => applyFit(ctx)));
    section.appendChild(fit);

    // A size the store would refuse is caught here instead of as an error after the
    // click. The reason replaces the floor line, so a disabled button is never just
    // inert: it says which rule it is up against.
    const syncResize = (): void => {
      const reason = resizeBlocker(floor, canvas, state.resizeWidth, state.resizeHeight);
      resize.disabled = reason !== null;
      hint.textContent = reason ?? hintBase;
      hint.classList.toggle('is-blocked', reason !== null);
      const atFloor =
        floor.hasContent && canvas.width === floor.width && canvas.height === floor.height;
      fit.disabled = !floor.hasContent || atFloor;
      fit.title = !floor.hasContent
        ? 'Nothing is drawn yet'
        : atFloor
          ? 'Already at the smallest size the content allows'
          : 'Resize straight down to the drawn content';
    };
    syncResize();
  }
  actions.appendChild(section);
  if (!assetTarget) {
    actions.appendChild(frameFromFootage(ctx));
  }
  // Extraction lands on this face, so the way out of the Draft it made has to be
  // here too — the Clip face offers the same Discard.
  if (draft && draft.characterId === state.activeCharacterId) {
    actions.appendChild(discardDraftSection(ctx, draft.characterId, draft.draftId));
  }

  // Warnings and what is already placed are read-only here: they sit under the
  // controls rather than between them. With neither there is nothing to add.
  if (
    state.alignmentWarnings.length === 0 &&
    state.alignment.clips.length === 0 &&
    state.alignment.drafts.length === 0
  ) {
    return;
  }
  const readout = make('section', 'inspector-section');
  readout.dataset.inspectorSection = 'alignment-info';
  readout.appendChild(subheading('Placed'));

  for (const warning of state.alignmentWarnings) {
    const node = make('p', 'warning');
    node.dataset.alignmentWarning = warning.code;
    node.textContent = warning.message;
    readout.appendChild(node);
  }

  // Placed work as thumbnails: a Draft is picked to drag its ghost on the Canvas,
  // a committed Clip is opened (which is where its Fork lives) when clicked.
  const thumbs = make('ul', 'align-thumbs');
  const characterId = state.activeCharacterId ?? '';
  for (const draft of state.alignment.drafts) {
    const item = make('li', 'align-thumb');
    item.dataset.alignThumbDraft = draft.id;
    item.title = draft.id;
    const img = document.createElement('img');
    img.src = ctx.api.frameUrl(characterId, draft.id, 0);
    img.alt = draft.id;
    if (draft.flipX) {
      img.classList.add('is-mirrored');
    }
    item.appendChild(img);
    item.addEventListener('click', () => {
      void ctx.loadDraft(characterId, draft.id).then(() => ctx.setMode('align'));
    });
    thumbs.appendChild(item);
  }
  for (const clip of state.alignment.clips) {
    const off = clip.placementOffset ?? { x: 0, y: 0 };
    const item = make('li', 'align-thumb');
    item.dataset.alignClipOffset = clip.id;
    item.dataset.offsetX = String(off.x);
    item.dataset.offsetY = String(off.y);
    item.title = `${clip.id} · (${off.x}, ${off.y})`;
    const img = document.createElement('img');
    // The sheet is one wide strip; the thumb shows its first frame by clipping.
    // A committed sheet is already baked mirrored, so it needs no flip here.
    img.src = ctx.api.sheetUrl(characterId, 'clip', clip.id);
    img.alt = clip.id;
    item.appendChild(img);
    item.appendChild(make('span', 'align-thumb-id', clip.id));
    // Clicking a committed Clip opens it, which is where its Fork lives — the way
    // back to an editable Draft from the placement view.
    const open = make('button', 'align-thumb-open') as HTMLButtonElement;
    open.dataset.alignClipOpen = clip.id;
    open.setAttribute('aria-label', `Open ${clip.id}`);
    open.title = `Open ${clip.id}`;
    open.addEventListener('click', () => {
      void ctx.loadAsset(characterId, 'clip', clip.id);
    });
    item.appendChild(open);
    thumbs.appendChild(item);
  }
  readout.appendChild(thumbs);
  info.appendChild(readout);
}

/**
 * Which Clip of the composition the offset applies to.
 *
 * A re-align is judged at a seam, and a composition is usually read seam by seam,
 * so the panel — not just the stage — has to be able to say "adjust *that* one".
 * Switching drops the fork in flight; taking the Clip already in hand just walks
 * the preview back to its seam.
 */
function targetPicker(ctx: AlignInspectorPort, activeSlot: number): HTMLElement {
  const composition = ctx.state.sequenceDraft;
  const wrap = make('div', 'align-targets');
  wrap.dataset.alignTargets = '';
  if (!composition) {
    return wrap;
  }
  wrap.appendChild(make('span', 'k', 'Clip'));
  composition.clips.forEach((clipId, index) => {
    const chip = make('button', 'btn small ghost align-target', clipId) as HTMLButtonElement;
    chip.dataset.alignTarget = String(index);
    if (index === activeSlot) {
      chip.dataset.active = '';
      chip.setAttribute('aria-current', 'true');
      chip.title = `Back to the seam before ${clipId}`;
    } else {
      chip.title = `Adjust ${clipId} instead — the fork in flight is dropped`;
    }
    chip.addEventListener('click', () => ctx.preview.realign(index));
    wrap.appendChild(chip);
  });
  return wrap;
}

/**
 * A committed Asset's placement: its recorded offset, read-only, plus the fork
 * that makes it editable again.
 */
function showAssetPlacement(
  ctx: AlignInspectorPort,
  section: HTMLElement,
  characterId: string,
  assetKind: 'clip' | 'sequence',
  assetId: string,
): void {
  if (assetKind === 'sequence') {
    section.appendChild(
      make('p', 'muted', 'A Sequence has no offset of its own — place its source Clips.'),
    );
    return;
  }
  const entry = ctx.state.alignment?.clips.find((clip) => clip.id === assetId);
  const offset = entry?.placementOffset ?? { x: 0, y: 0 };
  const list = make('dl', 'kv');
  addRow(list, 'offset', `${offset.x}, ${offset.y}`);
  addRow(list, 'mirror', entry?.flipX ? 'mirrored' : 'off');
  section.appendChild(list);
  section.appendChild(
    make('p', 'muted', 'Committed — this placement is baked. Fork the Clip to move it.'),
  );

  const fork = make('button', 'btn small', 'Fork to move') as HTMLButtonElement;
  fork.dataset.alignFork = '';
  fork.addEventListener('click', () => {
    ctx.run('Fork', async () => {
      const draft = await ctx.api.forkClip(characterId, assetId, freeDraftId(ctx, characterId, assetId));
      await ctx.rescan();
      await ctx.loadDraft(characterId, draft.id);
    });
  });
  section.appendChild(fork);
}

/** The first free `<asset>-fork`, `<asset>-fork-2`, … draft id. */
function freeDraftId(ctx: AlignInspectorPort, characterId: string, assetId: string): string {
  const taken = new Set(
    ctx.state.scan?.characters.find((candidate) => candidate.id === characterId)?.drafts.map(
      (draft) => draft.id,
    ) ?? [],
  );
  const base = `${assetId}-fork`;
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

/**
 * Why a requested Canvas size would be refused, or `null` when it would be taken.
 *
 * These are the same rules the store enforces; checking them here is what turns a
 * rejected save into a disabled button with a readable reason. The store still
 * validates — this only keeps the common case out of its error path.
 */
function resizeBlocker(
  floor: ContentFloor,
  canvas: Canvas,
  width: number,
  height: number,
): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return 'both sizes must be whole numbers above zero';
  }
  if (width % 2 !== 0) {
    return 'width must be even so the Anchor can sit at its centre';
  }
  if (width < floor.width || height < floor.height) {
    return `below the content floor ${floor.width}×${floor.height}`;
  }
  if (width === canvas.width && height === canvas.height) {
    return 'already the Canvas size';
  }
  return null;
}

/**
 * The step that retires a blank Character's provisional Canvas: derive the framing
 * from the open Recording and write it. Only offered while a Recording is open, and
 * explained when it is not, so the placeholder is never left in place by accident.
 *
 * Rather than let a click fail, the framing the footage implies is measured when
 * the section renders: the button stays disabled while that is unknown, and stays
 * disabled afterwards if the framing is already in place or would crop what is
 * drawn (the store's content floor). The reason is on screen either way.
 */
function frameFromFootage(ctx: AlignInspectorPort): HTMLElement {
  const wrap = make('section', 'inspector-section');
  wrap.dataset.inspectorSection = 'framing';
  wrap.appendChild(subheading('Framing'));

  const characterId = ctx.state.activeCharacterId;
  const recordingId = ctx.state.recordingId;
  if (characterId === null || recordingId === null) {
    wrap.appendChild(
      make('p', 'muted', 'Open a Recording from the Character to frame its Canvas from a frame.'),
    );
    return wrap;
  }

  const cut = (ctx.state.cutList?.cuts ?? []).find(
    (segment) => ctx.state.frame >= segment.startFrame && ctx.state.frame < segment.endFrame,
  );
  const note = make('p', 'muted', 'Measuring the frame…');
  note.dataset.frameCanvasNote = '';
  wrap.appendChild(note);

  const button = make('button', 'btn small', 'Frame canvas from frame') as HTMLButtonElement;
  button.dataset.frameCanvasRun = '';
  button.disabled = true;
  button.addEventListener('click', () => {
    ctx.run('Frame canvas', async () => {
      await ctx.api.frameCanvas(characterId, {
        recordingId,
        ...(cut === undefined ? {} : { cutId: cut.id }),
      });
      await refreshAlignment(ctx, characterId);
    });
  });
  wrap.appendChild(button);

  void measureFraming(ctx, recordingId, cut?.id, note, button);
  return wrap;
}

/** Fill in the framing note and decide whether the button may be pressed. */
async function measureFraming(
  ctx: AlignInspectorPort,
  recordingId: string,
  cutId: string | undefined,
  note: HTMLElement,
  button: HTMLButtonElement,
): Promise<void> {
  let derived;
  try {
    derived = await ctx.api.deriveAnchor(recordingId, cutId);
  } catch (error) {
    if (!note.isConnected) {
      return;
    }
    note.textContent = `The frame cannot be measured: ${(error as Error).message}`;
    return;
  }
  // The inspector may have been rebuilt while this was in flight (a repaint, a
  // selection change); a detached note would otherwise write to a dead node.
  if (!note.isConnected) {
    return;
  }

  const canvas = ctx.state.alignment?.canvas;
  const floor = ctx.state.alignment?.contentFloor;
  const where = cutId ? `cut "${cutId}"` : `frame ${derived.frame}`;
  if (canvas && derived.canvas.width === canvas.width && derived.canvas.height === canvas.height) {
    note.textContent = `Already framed at ${canvas.width}×${canvas.height} from ${where}.`;
    button.disabled = true;
    button.title = 'The Canvas already matches this frame';
    return;
  }
  if (
    floor?.hasContent &&
    (derived.canvas.width < floor.width || derived.canvas.height < floor.height)
  ) {
    note.textContent =
      `${where} frames to ${derived.canvas.width}×${derived.canvas.height}, below the ` +
      `content floor ${floor.width}×${floor.height}; it would crop what is drawn.`;
    button.disabled = true;
    button.title = 'Framing would crop drawn content';
    return;
  }
  note.textContent = `Would frame the Canvas to ${derived.canvas.width}×${derived.canvas.height} from ${where}.`;
  button.disabled = false;
}

/**
 * Throw a Draft away from the Placement face.
 *
 * A Draft is working data, so dropping it loses no committed Asset; the Copy says
 * what goes with it. The store has nothing to refuse here, so the button is always
 * pressable — the confirmation is the guard.
 */
function discardDraftSection(
  ctx: AlignInspectorPort,
  characterId: string,
  draftId: string,
): HTMLElement {
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'discard';
  section.appendChild(subheading('Discard'));
  section.appendChild(
    make('p', 'muted', 'Deletes the Draft frames and the Repair script it owns.'),
  );

  const button = make('button', 'btn small ghost', 'Discard draft') as HTMLButtonElement;
  button.dataset.discardDraft = '';
  button.addEventListener('click', () => {
    ctx.run('Discard draft', async () => {
      if (!(await confirmAction(`Discard draft "${draftId}"?`, 'Discard'))) {
        return;
      }
      await ctx.api.discardDraft(characterId, draftId);
      // The target was the Draft, which no longer exists: fall back to its Character.
      ctx.state.target = { kind: 'character', characterId };
      ctx.state.draftDescriptor = null;
      ctx.state.repair = null;
      // Dropping a re-align fork drops the re-align: the composition is still open
      // and its slot keeps the old Clip.
      if (ctx.state.realign?.forkDraftId === draftId) {
        ctx.state.realign = null;
      }
      await ctx.rescan();
      if (ctx.state.sequenceDraft !== null) {
        ctx.state.target = { kind: 'character', characterId };
        ctx.setMode('compose');
        await ctx.loadAlignment(characterId);
        return;
      }
      ctx.setMode('align');
      await ctx.loadAlignment(characterId);
    });
  });
  section.appendChild(button);
  return section;
}

/** The active Draft's offset as currently known to the client. */
function currentDraftOffset(ctx: AlignInspectorPort): PlacementOffset {
  const draft = activeDraft(ctx.state);
  const alignment = ctx.state.alignment;
  if (!draft || !alignment) {
    return { x: 0, y: 0 };
  }
  const entry = alignment.drafts.find((candidate) => candidate.id === draft.draftId);
  return entry?.placementOffset ?? { x: 0, y: 0 };
}

/** The active Draft's mirror as currently known to the client. */
function currentDraftFlip(ctx: AlignInspectorPort): boolean {
  const draft = activeDraft(ctx.state);
  const alignment = ctx.state.alignment;
  if (!draft || !alignment) {
    return false;
  }
  return alignment.drafts.find((candidate) => candidate.id === draft.draftId)?.flipX === true;
}

async function applyFlip(ctx: AlignInspectorPort, flipX: boolean): Promise<void> {
  const draft = activeDraft(ctx.state);
  if (!draft) {
    return;
  }
  // The Clip face reads the Draft descriptor, so the write's answer replaces the
  // held one; without that a mirror would only ever be visible on this face.
  ctx.state.draftDescriptor = await ctx.api.setFlipX(draft.characterId, draft.draftId, flipX);
  await refreshAlignment(ctx, draft.characterId);
}

function scheduleOffset(ctx: AlignInspectorPort): void {
  if (offsetTimer !== null) {
    clearTimeout(offsetTimer);
  }
  offsetTimer = setTimeout(() => {
    offsetTimer = null;
    ctx.run('Set offset', () => applyOffset(ctx, readOffsetInputs(ctx)));
  }, 250);
}

/** Read the offset straight off the inputs, so a pending edit is never lost. */
function readOffsetInputs(ctx: AlignInspectorPort): PlacementOffset {
  const x = ctx.regions.inspector.querySelector<HTMLInputElement>('[data-align-offset-x]');
  const y = ctx.regions.inspector.querySelector<HTMLInputElement>('[data-align-offset-y]');
  return {
    x: x ? Number(x.value) || 0 : 0,
    y: y ? Number(y.value) || 0 : 0,
  };
}

async function applyOffset(ctx: AlignInspectorPort, offset: PlacementOffset): Promise<void> {
  const draft = activeDraft(ctx.state);
  if (!draft) {
    return;
  }
  // A re-render replaces the inputs, so remember which one the caret was in and
  // put it back — otherwise typing an offset would only ever land one digit.
  const focused = document.activeElement;
  const keepX = focused instanceof HTMLElement && focused.hasAttribute('data-align-offset-x');
  const keepY = focused instanceof HTMLElement && focused.hasAttribute('data-align-offset-y');

  ctx.state.draftDescriptor = await ctx.api.setPlacementOffset(
    draft.characterId,
    draft.draftId,
    offset,
  );
  const alignment = await ctx.api.readDraftAlignment(draft.characterId, draft.draftId);
  ctx.state.alignmentWarnings = alignment.warnings;
  await refreshAlignment(ctx, draft.characterId);

  const restore = keepX
    ? ctx.regions.inspector.querySelector<HTMLInputElement>('[data-align-offset-x]')
    : keepY
      ? ctx.regions.inspector.querySelector<HTMLInputElement>('[data-align-offset-y]')
      : null;
  restore?.focus();
}

async function applyResize(ctx: AlignInspectorPort): Promise<void> {
  const characterId = ctx.state.activeCharacterId;
  if (!characterId) {
    return;
  }
  const canvas = ctx.state.alignment?.canvas;
  const width = ctx.state.resizeWidth || canvas?.width || 0;
  const height = ctx.state.resizeHeight || canvas?.height || 0;
  await ctx.api.resizeCanvas(characterId, width, height);
  ctx.state.alignmentWarnings = [];
  await refreshAlignment(ctx, characterId);
}

async function applyFit(ctx: AlignInspectorPort): Promise<void> {
  const characterId = ctx.state.activeCharacterId;
  if (!characterId) {
    return;
  }
  await ctx.api.fitCanvas(characterId);
  ctx.state.alignmentWarnings = [];
  await refreshAlignment(ctx, characterId);
}

async function refreshAlignment(
  ctx: AlignInspectorPort,
  characterId: string,
): Promise<void> {
  ctx.state.alignment = await ctx.api.readCharacterAlignment(characterId);
  // The canvas may have just changed; the expand inputs follow it until edited.
  ctx.state.resizeWidth = ctx.state.alignment.canvas.width;
  ctx.state.resizeHeight = ctx.state.alignment.canvas.height;
  ctx.renderStage();
  ctx.renderInspector();
}
