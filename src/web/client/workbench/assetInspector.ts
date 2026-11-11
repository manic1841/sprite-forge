/**
 * The inspector for a committed **Asset**: facts, provenance, and the three
 * things that can be done to one — fork it into a Draft, verify it re-bakes,
 * delete it.
 *
 * A committed Asset is immutable (ADR-0002), so editing always starts with a
 * fork; that is why Fork is the first action here.
 */

import type { AssetInspectorPort } from './ports.js';
import { confirmAction } from './dialog.js';
import { addRow, labeled, make, subheading } from './dom.js';
import { activeAsset } from './state.js';

export function assetInspector(
  ctx: AssetInspectorPort,
  actions: HTMLElement,
  info: HTMLElement,
): void {
  const asset = ctx.state.asset;
  const target = activeAsset(ctx.state);
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'asset';
  section.appendChild(subheading(target?.assetKind === 'sequence' ? 'Sequence' : 'Clip'));

  if (!asset || !target) {
    section.appendChild(make('p', 'muted', 'Select an asset in the Library.'));
    info.appendChild(section);
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
  info.appendChild(section);

  // Fork and Verify lead: an Asset is immutable, so Fork is the way back to an
  // editable Draft.
  const tools = make('section', 'inspector-section');
  tools.dataset.inspectorSection = 'asset-actions';
  const actionRow = make('div', 'asset-actions');
  actionRow.appendChild(forkControls(ctx, target.characterId, target.assetKind, target.assetId));
  const verify = make('button', 'btn small ghost', 'Verify reproducible') as HTMLButtonElement;
  verify.dataset.assetVerify = '';
  verify.addEventListener('click', () => {
    ctx.run('Verify', () => verifyAsset(ctx, target.characterId, target.assetKind, target.assetId));
  });
  actionRow.appendChild(verify);
  tools.appendChild(actionRow);
  actions.appendChild(tools);
}

/** Fork inputs: the id for the new Draft (pre-filled with a free one). */
function forkControls(
  ctx: AssetInspectorPort,
  characterId: string,
  assetKind: 'clip' | 'sequence',
  assetId: string,
): HTMLElement {
  const wrap = make('span', 'fork');
  const input = document.createElement('input');
  input.dataset.forkId = '';
  input.value = freeId(ctx, characterId, `${assetId}-fork`);
  input.placeholder = 'draft id';
  const button = make('button', 'btn small', 'Fork to draft') as HTMLButtonElement;
  button.dataset.forkRun = '';
  button.addEventListener('click', () => {
    ctx.run('Fork', () => forkAsset(ctx, characterId, assetKind, assetId, input.value.trim()));
  });
  wrap.append(labeled('draft id', input), button);
  return wrap;
}

/** The first id of the `base`, `base-2`, … series not already taken. */
function freeId(ctx: AssetInspectorPort, characterId: string, base: string): string {
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

async function forkAsset(
  ctx: AssetInspectorPort,
  characterId: string,
  assetKind: 'clip' | 'sequence',
  assetId: string,
  draftId: string,
): Promise<void> {
  if (assetKind === 'sequence') {
    // A Sequence has no frames of its own; forking it writes a composition draft
    // and opens it on the Character's Compose face, where its Clip list lives.
    const fork = await ctx.api.forkSequence(characterId, assetId);
    const draft = await ctx.api.saveSequenceDraft(characterId, {
      clips: fork.clips,
      forkOf: assetId,
    });
    ctx.state.sequenceDraft = draft;
    await ctx.rescan();
    await ctx.loadCharacter(characterId);
    ctx.setMode('compose');
    return;
  }
  const draft = await ctx.api.forkClip(characterId, assetId, draftId === '' ? undefined : draftId);
  await ctx.rescan();
  await ctx.loadDraft(characterId, draft.id);
}

async function verifyAsset(
  ctx: AssetInspectorPort,
  characterId: string,
  assetKind: 'clip' | 'sequence',
  assetId: string,
): Promise<void> {
  ctx.state.reproducible = await ctx.api.verifyReproducible(characterId, assetKind, assetId);
  ctx.renderInspector();
}

/** Delete, behind a confirmation. */
function deleteControls(
  ctx: AssetInspectorPort,
  characterId: string,
  assetKind: 'clip' | 'sequence',
  assetId: string,
): HTMLElement {
  const wrap = make('div', 'asset-delete');
  wrap.appendChild(make('h4', 'ttl mini', 'Delete'));
  const button = make('button', 'btn small ghost', 'Delete asset') as HTMLButtonElement;
  button.dataset.assetDelete = '';
  button.addEventListener('click', () => {
    // The ask runs inside `run` so the whole gesture — wait, then delete — is
    // one tracked action rather than a fire-and-forget tail after it.
    ctx.run('Delete asset', async () => {
      const asked = await confirmAction(
        `Delete ${assetKind} "${assetId}"? This cannot be undone.`,
        'Delete',
      );
      if (!asked) {
        return;
      }
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
