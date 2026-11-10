/**
 * The inspector: facts and actions for whatever face is on screen.
 *
 * The section follows the **target** (a Recording, a Draft, a Character, an
 * Export), not the mode, so the panel always describes the thing in the stage
 * next to it. The `[data-region="inspector"]` node itself persists.
 */

import type { WorkbenchContext } from './context.js';
import {
  addRow,
  colorInput,
  labeled,
  make,
  numberInput,
  scopeSelect,
  sizeInput,
  subheading,
} from './dom.js';
import { undoRepair, warningRow } from './repair.js';
import { activeAsset, activeDraft, activeExport } from './state.js';
import type { ClipDraft, PlacementOffset } from '../types.js';

/** Render the inspector for the current target and mode. */
export function renderInspector(ctx: WorkbenchContext): void {
  const { inspector } = ctx.regions;
  const { state } = ctx;
  inspector.innerHTML = '';
  inspector.dataset.inspectorFor = state.mode;
  inspector.appendChild(make('h3', 'ttl', 'Inspector'));

  if (state.loadError !== null) {
    const notice = make('p', 'muted load-error-note', state.loadError);
    notice.dataset.loadErrorNote = '';
    inspector.appendChild(notice);
  }

  if (state.mode === 'align') {
    alignInspector(ctx);
    return;
  }
  if (state.mode === 'export') {
    exportInspector(ctx);
    return;
  }
  if (state.target.kind === 'draft') {
    draftInspector(ctx);
    return;
  }
  if (state.target.kind === 'asset') {
    assetInspector(ctx);
    return;
  }
  recordingInspector(ctx);
}

// --- Recording ---------------------------------------------------------------

/** What the loaded Recording is, and what can be done with its segments. */
function recordingInspector(ctx: WorkbenchContext): void {
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'recording';
  section.appendChild(subheading('Recording'));

  const recordingId = ctx.state.recordingId;
  const cutList = ctx.state.cutList;
  if (!recordingId || !cutList) {
    section.appendChild(
      make('p', 'muted', 'Select a Recording to cut it into segments, then extract one.'),
    );
    ctx.regions.inspector.appendChild(section);
    return;
  }

  const list = make('dl', 'kv');
  addRow(list, 'recording', recordingId);
  addRow(list, 'frames', String(cutList.frameCount));
  addRow(list, 'frame', String(ctx.state.frame));
  addRow(list, 'segments', String(cutList.cuts.length));
  addRow(list, 'hash', cutList.hash.replace(/^sha256:/, '').slice(0, 12));
  section.appendChild(list);
  section.appendChild(
    make(
      'p',
      'muted',
      'Drag a segment edge in the filmstrip to re-cut, then Extract a segment to start a Draft.',
    ),
  );
  ctx.regions.inspector.appendChild(section);
}

// --- Draft -------------------------------------------------------------------

/** The active Draft's per-frame facts, its Repair slot, and Commit. */
function draftInspector(ctx: WorkbenchContext): void {
  const draft = ctx.state.draftDescriptor;
  const target = activeDraft(ctx.state);

  const facts = make('section', 'inspector-section');
  facts.dataset.inspectorSection = 'draft';
  facts.appendChild(subheading('Draft'));

  if (!draft || !target) {
    facts.appendChild(make('p', 'muted', 'Select a Draft to inspect its frames.'));
  } else {
    const list = make('dl', 'kv');
    addRow(list, 'character', target.characterId);
    addRow(list, 'draft', target.draftId);
    addRow(list, 'recording', draft.recordingId);
    addRow(
      list,
      'segment',
      `${draft.segment.cutId} [${draft.segment.startFrame}, ${draft.segment.endFrame})`,
    );
    addRow(list, 'frames', String(draft.frameCount));
    addRow(list, 'frame', String(ctx.state.draftFrame));
    addRow(list, 'delay', `${draftDelayMs(draft, ctx.state.draftFrame)} ms`);
    addRow(list, 'background', draft.background.hex);
    addRow(list, 'loop', String(draft.loop));
    facts.appendChild(list);
  }
  ctx.regions.inspector.appendChild(facts);

  const repair = make('section', 'inspector-section');
  repair.dataset.inspectorSection = 'repair';
  repair.appendChild(subheading('Repair'));
  const controls = make('div', 'repair-controls');
  controls.dataset.repairControls = '';
  repairControls(ctx, controls);
  repair.appendChild(controls);
  ctx.regions.inspector.appendChild(repair);

  ctx.regions.inspector.appendChild(commitSection(ctx));
  ctx.regions.inspector.appendChild(discardSection(ctx));
}

/** A Draft frame's delay: `delaysMs` is either uniform (1) or per-frame. */
function draftDelayMs(draft: ClipDraft, frame: number): number {
  const index = Math.min(frame, draft.delaysMs.length - 1);
  return draft.delaysMs[index] ?? draft.delaysMs[0] ?? 0;
}

/** Fill the `[data-repair-controls]` slot: tools, brush settings, warnings, op list. */
function repairControls(ctx: WorkbenchContext, controls: HTMLElement): void {
  const { state } = ctx;
  if (!state.draftDescriptor || state.target.kind !== 'draft') {
    controls.appendChild(make('p', 'muted', 'Select a Draft to repair its frames.'));
    return;
  }

  const tools = make('div', 'repair-tools');
  const toolButton = (tool: typeof state.tool, label: string): void => {
    const button = make('button', 'btn small', label);
    button.dataset.repairTool = tool;
    button.classList.toggle('on', state.tool === tool);
    button.addEventListener('click', () => {
      state.tool = tool;
      ctx.renderInspector();
    });
    tools.appendChild(button);
  };
  toolButton('paint', 'Brush');
  toolButton('erase', 'Eraser');
  toolButton('rect', 'Rect');
  toolButton('eyedropper', 'Eyedropper');
  controls.appendChild(tools);

  const settings = make('div', 'repair-settings');
  settings.appendChild(
    labeled(
      'Colour',
      colorInput(state.brushColor, (value) => {
        state.brushColor = value;
        state.tool = 'paint';
      }),
    ),
  );
  settings.appendChild(
    labeled(
      'Size',
      sizeInput(state.brushSize, (value) => {
        state.brushSize = Math.max(1, Math.round(value));
      }),
    ),
  );
  settings.appendChild(
    labeled(
      'Scope',
      scopeSelect(state.scope, (value) => {
        state.scope = value;
      }),
    ),
  );
  controls.appendChild(settings);

  const undo = make('button', 'btn small', 'Undo') as HTMLButtonElement;
  undo.dataset.repairUndo = '';
  undo.disabled = (state.repair?.operations.length ?? 0) === 0;
  undo.addEventListener('click', () => void ctx.run('Undo repair', () => undoRepair(ctx)));
  controls.appendChild(undo);

  for (const warning of state.repair?.warnings ?? []) {
    controls.appendChild(warningRow(warning));
  }

  controls.appendChild(make('h4', 'ttl sub', 'Operations'));
  const list = make('ol', 'repair-ops');
  list.dataset.repairOps = '';
  const operations = state.repair?.operations ?? [];
  if (operations.length === 0) {
    list.appendChild(make('li', 'muted', 'No Repair operations yet.'));
  }
  operations.forEach((operation, index) => {
    const item = make('li', 'repair-op');
    item.dataset.repairOp = '';
    item.dataset.repairOpIndex = String(index);
    item.dataset.repairTool = operation.tool;
    item.textContent = `${operation.tool} · frames [${operation.frames.start}–${operation.frames.end})`;
    list.appendChild(item);
  });
  controls.appendChild(list);
}

/** Commit the Draft into an immutable Clip. */
function commitSection(ctx: WorkbenchContext): HTMLElement {
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'commit';
  section.appendChild(subheading('Commit'));

  const target = activeDraft(ctx.state);
  if (!target) {
    section.appendChild(make('p', 'muted', 'Commit turns this Draft into an immutable Clip.'));
    return section;
  }

  const nameInput = document.createElement('input');
  nameInput.dataset.commitName = '';
  // A Draft is often derived from the Clip it replaces, so the obvious name is
  // already taken; offering the first free one saves a rejected commit.
  nameInput.value = freeClipId(ctx, target.characterId, target.draftId);
  const button = make('button', 'btn small', 'Commit as Clip') as HTMLButtonElement;
  button.dataset.commitRun = '';
  const message = make('p', 'muted');
  message.dataset.commitMessage = '';

  button.addEventListener('click', () => {
    void ctx.run('Commit', () =>
      commit(ctx, target.characterId, target.draftId, nameInput.value.trim(), message),
    );
  });

  section.append(labeled('Clip name', nameInput), button, message);
  return section;
}

/** The first id of the `base`, `base-2`, `base-3`, … series not already taken. */
function freeClipId(ctx: WorkbenchContext, characterId: string, base: string): string {
  const taken = new Set(
    ctx.state.scan?.characters
      .find((candidate) => candidate.id === characterId)
      ?.assets.map((asset) => asset.id) ?? [],
  );
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

/** Throw the Draft away: the only exit for one that is not worth committing. */
function discardSection(ctx: WorkbenchContext): HTMLElement {
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'discard';
  section.appendChild(subheading('Discard'));

  const target = activeDraft(ctx.state);
  if (!target) {
    return section;
  }
  section.appendChild(
    make('p', 'muted', 'Deletes the Draft frames and the Repair script it owns.'),
  );
  const button = make('button', 'btn small ghost', 'Discard draft') as HTMLButtonElement;
  button.dataset.discardDraft = '';
  button.addEventListener('click', () => {
    if (!window.confirm(`Discard draft "${target.draftId}"?`)) {
      return;
    }
    void ctx.run('Discard draft', () => discardDraft(ctx, target.characterId, target.draftId));
  });
  section.appendChild(button);
  return section;
}

async function discardDraft(
  ctx: WorkbenchContext,
  characterId: string,
  draftId: string,
): Promise<void> {
  await ctx.api.discardDraft(characterId, draftId);
  // The target was the Draft, which no longer exists: fall back to its Character.
  ctx.state.target = { kind: 'character', characterId };
  ctx.state.draftDescriptor = null;
  ctx.state.repair = null;
  await ctx.rescan();
  ctx.setMode('align');
  await ctx.loadAlignment(characterId);
}

async function commit(
  ctx: WorkbenchContext,
  characterId: string,
  draftId: string,
  name: string,
  message: HTMLElement,
): Promise<void> {
  if (!name) {
    message.textContent = 'a Clip name is required';
    return;
  }
  try {
    const committed = await ctx.api.commitDraft(characterId, draftId, name);
    // Committing consumes the Draft, so the open target has to move: the new Clip
    // is shown on its own face, where it plays back like any committed Asset.
    ctx.state.draftDescriptor = null;
    ctx.state.repair = null;
    await ctx.rescan();
    await ctx.loadAsset(characterId, 'clip', committed.id);
  } catch (error) {
    message.textContent = (error as Error).message;
  }
}

// --- Asset -------------------------------------------------------------------

/**
 * A committed Asset: its validated facts, its provenance, and the three things
 * that can be done to one — fork it into a Draft, verify it re-bakes, delete it.
 *
 * A committed Asset is immutable (ADR-0002), so editing always starts with a
 * fork; that is why Fork is the first action here.
 */
function assetInspector(ctx: WorkbenchContext): void {
  const asset = ctx.state.asset;
  const target = activeAsset(ctx.state);
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'asset';
  section.appendChild(subheading(target?.assetKind === 'sequence' ? 'Sequence' : 'Clip'));

  if (!asset || !target) {
    section.appendChild(make('p', 'muted', 'Select an asset in the Library.'));
    ctx.regions.inspector.appendChild(section);
    return;
  }

  const list = make('dl', 'kv');
  addRow(list, 'character', target.characterId);
  addRow(list, 'id', asset.id);
  addRow(list, 'frames', String(asset.meta.frameCount));
  addRow(list, 'loop', String(asset.meta.loop));
  addRow(list, 'delay', `${asset.meta.delaysMs[0] ?? 0} ms`);
  // `CommittedAsset.kind` is the open `AssetKind`, so the provenance shape is what
  // actually distinguishes a Sequence from a Clip here.
  if ('clips' in asset.provenance) {
    addRow(list, 'clips', asset.provenance.clips.join(' → '));
    addRow(list, 'forked from', asset.provenance.derivedFrom?.id ?? '—');
  } else {
    addRow(list, 'recording', asset.provenance.recordingId);
    addRow(
      list,
      'segment',
      `${asset.provenance.segment.cutId} [${asset.provenance.segment.startFrame}, ${asset.provenance.segment.endFrame})`,
    );
    addRow(list, 'background', asset.provenance.background.hex);
    addRow(list, 'forked from', asset.provenance.derivedFrom?.id ?? '—');
  }
  section.appendChild(list);

  const actions = make('div', 'asset-actions');
  actions.appendChild(forkControls(ctx, target.characterId, target.assetKind, target.assetId));
  const verify = make('button', 'btn small ghost', 'Verify reproducible') as HTMLButtonElement;
  verify.dataset.assetVerify = '';
  verify.addEventListener('click', () => {
    void ctx.run('Verify', () => verifyAsset(ctx, target.characterId, target.assetKind, target.assetId));
  });
  actions.appendChild(verify);
  section.appendChild(actions);

  const report = ctx.state.reproducible;
  if (report) {
    const node = make('p', report.reproducible ? 'muted' : 'warning');
    node.dataset.assetReproducible = String(report.reproducible);
    node.textContent = report.reproducible
      ? 'Re-bakes byte-identically.'
      : `Re-bake differs: ${report.mismatches
          .map((mismatch) => `${mismatch.artifact} (${mismatch.detail})`)
          .join('; ')}`;
    section.appendChild(node);
  }

  section.appendChild(deleteControls(ctx, target.characterId, target.assetKind, target.assetId));
  ctx.regions.inspector.appendChild(section);
}

/** Fork inputs: the id for the new Draft (pre-filled with a free one). */
function forkControls(
  ctx: WorkbenchContext,
  characterId: string,
  assetKind: 'clip' | 'sequence',
  assetId: string,
): HTMLElement {
  const wrap = make('span', 'fork');
  const input = document.createElement('input');
  input.dataset.forkId = '';
  input.value = freeClipId(ctx, characterId, `${assetId}-fork`);
  input.placeholder = 'draft id';
  const button = make('button', 'btn small', 'Fork to draft') as HTMLButtonElement;
  button.dataset.forkRun = '';
  button.addEventListener('click', () => {
    void ctx.run('Fork', () => forkAsset(ctx, characterId, assetKind, assetId, input.value.trim()));
  });
  wrap.append(labeled('draft id', input), button);
  return wrap;
}

async function forkAsset(
  ctx: WorkbenchContext,
  characterId: string,
  assetKind: 'clip' | 'sequence',
  assetId: string,
  draftId: string,
): Promise<void> {
  if (assetKind === 'sequence') {
    // A Sequence has no frames of its own; forking one opens its composition.
    const fork = await ctx.api.forkSequence(characterId, assetId);
    ctx.state.sequenceDraft = { name: fork.id, clips: [...fork.clips], forkOf: assetId };
    ctx.renderStage();
    ctx.renderInspector();
    return;
  }
  const draft = await ctx.api.forkClip(
    characterId,
    assetId,
    draftId === '' ? undefined : draftId,
  );
  await ctx.rescan();
  await ctx.loadDraft(characterId, draft.id);
}

async function verifyAsset(
  ctx: WorkbenchContext,
  characterId: string,
  assetKind: 'clip' | 'sequence',
  assetId: string,
): Promise<void> {
  ctx.state.reproducible = await ctx.api.verifyReproducible(characterId, assetKind, assetId);
  ctx.renderInspector();
}

/** Delete, behind a confirmation, naming the Sequences that still hold the Clip. */
function deleteControls(
  ctx: WorkbenchContext,
  characterId: string,
  assetKind: 'clip' | 'sequence',
  assetId: string,
): HTMLElement {
  const wrap = make('div', 'asset-delete');
  wrap.appendChild(make('h4', 'ttl sub', 'Delete'));
  const button = make('button', 'btn small ghost', 'Delete asset') as HTMLButtonElement;
  button.dataset.assetDelete = '';
  button.addEventListener('click', () => {
    if (!window.confirm(`Delete ${assetKind} "${assetId}"? This cannot be undone.`)) {
      return;
    }
    void ctx.run('Delete asset', async () => {
      await ctx.api.deleteAsset(characterId, assetKind, assetId);
      // The Asset is gone, so the target has to move off it.
      ctx.state.asset = null;
      ctx.state.target = { kind: 'character', characterId };
      await ctx.rescan();
      ctx.setMode('align');
      await ctx.loadAlignment(characterId);
    });
  });
  wrap.appendChild(button);
  return wrap;
}

// --- Alignment ---------------------------------------------------------------

/**
 * Per-Clip placement offsets and the explicit Character-wide expand action. The
 * offset edit targets the active Draft (a committed Clip is immutable — fork it
 * to change its offset); committed Clips' offsets are shown read-only.
 */
function alignInspector(ctx: WorkbenchContext): void {
  const { state } = ctx;
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'alignment';
  section.appendChild(subheading('Placement'));

  if (!state.alignment) {
    section.appendChild(make('p', 'muted', 'Select a Character or asset to align.'));
    ctx.regions.inspector.appendChild(section);
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
      void ctx.run('Set offset', () => {
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

  for (const warning of state.alignmentWarnings) {
    const node = make('p', 'warning');
    node.dataset.alignmentWarning = warning.code;
    node.textContent = warning.message;
    section.appendChild(node);
  }

  if (state.alignment.clips.length > 0) {
    section.appendChild(make('h4', 'ttl sub', 'Committed Clips'));
    const list = make('ul', 'align-clips');
    for (const clip of state.alignment.clips) {
      const item = make('li', 'align-clip');
      item.dataset.alignClipOffset = clip.id;
      const off = clip.placementOffset ?? { x: 0, y: 0 };
      item.dataset.offsetX = String(off.x);
      item.dataset.offsetY = String(off.y);
      item.textContent = `${clip.id} · (${off.x}, ${off.y})`;
      // Clicking a committed Clip opens it, which is where its Fork lives — the
      // way back to an editable Draft from the placement view.
      const open = make('button', 'btn small ghost', 'Open') as HTMLButtonElement;
      open.dataset.alignClipOpen = clip.id;
      open.addEventListener('click', () => {
        void ctx.loadAsset(state.activeCharacterId ?? '', 'clip', clip.id);
      });
      item.appendChild(open);
      list.appendChild(item);
    }
    section.appendChild(list);
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
  expand.addEventListener('click', () => void ctx.run('Expand canvas', () => applyExpand(ctx)));
  section.appendChild(expandRow);
  section.appendChild(expand);

  ctx.regions.inspector.appendChild(section);
}

/** The active Draft's offset as currently known to the client. */
function currentDraftOffset(ctx: WorkbenchContext): PlacementOffset {
  const draft = activeDraft(ctx.state);
  const alignment = ctx.state.alignment;
  if (!draft || !alignment) {
    return { x: 0, y: 0 };
  }
  const entry = alignment.drafts.find((candidate) => candidate.id === draft.draftId);
  return entry?.placementOffset ?? { x: 0, y: 0 };
}

/**
 * Pending offset write.
 *
 * The offset inputs fire on every keystroke. Writing each one straight through
 * meant two overlapping read-modify-write calls, and the second one saved a
 * `draft.json` the first was still writing. A short debounce collapses a burst of
 * typing into one write.
 */
let offsetTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleOffset(ctx: WorkbenchContext): void {
  if (offsetTimer !== null) {
    clearTimeout(offsetTimer);
  }
  offsetTimer = setTimeout(() => {
    offsetTimer = null;
    void ctx.run('Set offset', () => applyOffset(ctx, readOffsetInputs(ctx)));
  }, 250);
}

/** Read the offset straight off the inputs, so a pending edit is never lost. */
function readOffsetInputs(ctx: WorkbenchContext): PlacementOffset {
  const x = ctx.regions.inspector.querySelector<HTMLInputElement>('[data-align-offset-x]');
  const y = ctx.regions.inspector.querySelector<HTMLInputElement>('[data-align-offset-y]');
  return {
    x: x ? Number(x.value) || 0 : 0,
    y: y ? Number(y.value) || 0 : 0,
  };
}

async function applyOffset(ctx: WorkbenchContext, offset: PlacementOffset): Promise<void> {
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

async function applyExpand(ctx: WorkbenchContext): Promise<void> {
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

async function refreshAlignment(ctx: WorkbenchContext, characterId: string): Promise<void> {
  ctx.state.alignment = await ctx.api.readCharacterAlignment(characterId);
  ctx.renderStage();
  ctx.renderInspector();
}

// --- Export ------------------------------------------------------------------

/** The **live Manifest**: whatever the server read back and validated. */
function exportInspector(ctx: WorkbenchContext): void {
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'export';
  section.appendChild(subheading('Manifest'));

  const manifest = ctx.state.manifest?.manifest;
  if (!manifest) {
    section.appendChild(make('p', 'muted', 'The live manifest appears once an Export is loaded.'));
    ctx.regions.inspector.appendChild(section);
    return;
  }

  const pre = document.createElement('pre');
  pre.className = 'manifest';
  pre.dataset.manifest = '';
  pre.dataset.manifestTarget = manifest.target;
  pre.textContent = JSON.stringify(manifest, null, 2);
  section.appendChild(pre);
  ctx.regions.inspector.appendChild(section);
  void activeExport(ctx.state);
}
