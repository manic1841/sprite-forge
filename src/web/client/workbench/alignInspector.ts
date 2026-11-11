/**
 * The inspector for **Alignment**: placement offsets, the explicit Canvas
 * expand, framing from footage, and what is already placed.
 *
 * The offset edit targets the active Draft (a committed Clip is immutable — fork
 * it to change its offset); committed Clips' offsets are shown read-only.
 */

import type { AlignInspectorPort } from './ports.js';
import { labeled, make, numberInput, subheading } from './dom.js';
import { activeDraft } from './state.js';
import type { PlacementOffset } from '../types.js';

/**
 * Pending offset write.
 *
 * The offset inputs fire on every keystroke. Writing each one straight through
 * meant two overlapping read-modify-write calls, and the second one saved a
 * `draft.json` the first was still writing. A short debounce collapses a burst of
 * typing into one write.
 */
let offsetTimer: ReturnType<typeof setTimeout> | null = null;

export function alignInspector(
  ctx: AlignInspectorPort,
  actions: HTMLElement,
  info: HTMLElement,
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

  const draft = activeDraft(state);
  if (draft && draft.characterId === state.activeCharacterId) {
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
  } else {
    section.appendChild(
      make('p', 'muted', 'Select a Draft to edit its placement offset (fork an Asset to edit it).'),
    );
  }

  const expandRow = make('div', 'align-expand');
  const width = numberInput(state.expandWidth, 'width', (value) => {
    state.expandWidth = value;
  });
  width.dataset.expandWidth = '';
  const height = numberInput(state.expandHeight, 'height', (value) => {
    state.expandHeight = value;
  });
  height.dataset.expandHeight = '';
  expandRow.append(labeled('Width', width), labeled('Height', height));
  const expand = make('button', 'btn small', 'Expand canvas');
  expand.dataset.expandCanvasAction = '';
  expand.addEventListener('click', () => ctx.run('Expand canvas', () => applyExpand(ctx)));
  section.appendChild(expandRow);
  section.appendChild(expand);
  actions.appendChild(section);
  actions.appendChild(frameFromFootage(ctx));

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
 * The step that retires a blank Character's provisional Canvas: derive the framing
 * from the open Recording and write it. Only offered while a Recording is open, and
 * explained when it is not, so the placeholder is never left in place by accident.
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
  wrap.appendChild(
    make(
      'p',
      'muted',
      `Frames the Canvas from ${recordingId} frame ${cut ? cut.startFrame : ctx.state.frame}` +
        `${cut ? ` (cut "${cut.id}")` : ''}.`,
    ),
  );

  const button = make('button', 'btn small', 'Frame canvas from frame');
  button.dataset.frameCanvasRun = '';
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
  return wrap;
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

  await ctx.api.setPlacementOffset(draft.characterId, draft.draftId, offset);
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

async function applyExpand(ctx: AlignInspectorPort): Promise<void> {
  const characterId = ctx.state.activeCharacterId;
  if (!characterId) {
    return;
  }
  const canvas = ctx.state.alignment?.canvas;
  const width = ctx.state.expandWidth || canvas?.width || 0;
  const height = ctx.state.expandHeight || canvas?.height || 0;
  await ctx.api.expandCanvas(characterId, width, height);
  ctx.state.alignmentWarnings = [];
  await refreshAlignment(ctx, characterId);
}

async function refreshAlignment(
  ctx: AlignInspectorPort,
  characterId: string,
): Promise<void> {
  ctx.state.alignment = await ctx.api.readCharacterAlignment(characterId);
  // The canvas may have just changed; the expand inputs follow it until edited.
  ctx.state.expandWidth = ctx.state.alignment.canvas.width;
  ctx.state.expandHeight = ctx.state.alignment.canvas.height;
  ctx.renderStage();
  ctx.renderInspector();
}
