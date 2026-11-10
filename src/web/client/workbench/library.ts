/**
 * The Library rail: everything the store currently holds, grouped by kind.
 *
 * Import comes first under Recordings; below it, Recordings, Characters, Drafts,
 * committed Assets and Exports. The rail is a *view* of a scan — it owns no
 * state beyond the selection highlight.
 */

import type { WorkbenchContext } from './context.js';
import { heading, make, subheading } from './dom.js';
import { importForm } from './importForm.js';
import { activeAsset, activeDraft, activeExport } from './state.js';

/** Render the rail from the latest scan. */
export function renderLibrary(ctx: WorkbenchContext): void {
  const { rail } = ctx.regions;
  const { state } = ctx;
  rail.innerHTML = '';
  rail.appendChild(heading('Library'));

  // Recordings: the Import form on top, then what already exists.
  rail.appendChild(subheading('Recordings'));
  rail.appendChild(importForm(ctx));

  const recordings = make('div', 'list');
  recordings.dataset.librarySection = 'recordings';
  for (const recording of state.scan?.recordings ?? []) {
    const item = make('button', 'asset');
    item.dataset.recording = recording.id;
    item.classList.toggle('sel', recording.id === state.recordingId);
    item.append(
      make('span', 'asset-name', recording.id),
      make('span', 'asset-sub', recording.dir),
    );
    item.addEventListener('click', () => void ctx.loadRecording(recording.id));
    recordings.appendChild(item);
  }
  rail.appendChild(recordings);

  rail.appendChild(subheading('Drafts'));
  const drafts = make('div', 'list');
  drafts.dataset.librarySection = 'drafts';
  const open = activeDraft(state);
  for (const character of state.scan?.characters ?? []) {
    for (const draft of character.drafts) {
      const item = make('button', 'asset');
      item.dataset.draft = draft.id;
      item.dataset.draftCharacter = character.id;
      item.classList.toggle(
        'sel',
        open?.characterId === character.id && open.draftId === draft.id,
      );
      item.append(
        make('span', 'asset-name', draft.id),
        make('span', 'asset-sub', character.id),
      );
      item.addEventListener('click', () => void ctx.loadDraft(character.id, draft.id));
      drafts.appendChild(item);
    }
  }
  rail.appendChild(drafts);

  rail.appendChild(subheading('Committed assets'));
  const assets = make('div', 'list');
  assets.dataset.librarySection = 'assets';
  const openAsset = activeAsset(state);
  for (const character of state.scan?.characters ?? []) {
    for (const asset of character.assets) {
      const item = make('button', 'asset');
      item.dataset.asset = asset.id;
      item.dataset.assetKind = asset.kind;
      item.dataset.character = character.id;
      item.classList.toggle(
        'sel',
        openAsset?.characterId === character.id &&
          openAsset.assetId === asset.id &&
          openAsset.assetKind === asset.kind,
      );
      item.append(
        make('span', 'asset-name', asset.id),
        make('span', 'tag', asset.kind),
      );
      // A committed Asset opens on the clip face, where it plays back and can be
      // forked; the Alignment face is one click away for when placement is the job.
      item.addEventListener('click', () => void ctx.loadAsset(character.id, asset.kind, asset.id));
      assets.appendChild(item);
    }
  }
  rail.appendChild(assets);

  rail.appendChild(subheading('Exports'));
  const exports = make('div', 'list');
  exports.dataset.librarySection = 'exports';
  const openTarget = activeExport(state);
  for (const exported of state.scan?.exports ?? []) {
    const item = make('button', 'asset');
    item.dataset.exportTarget = exported.target;
    item.classList.toggle('sel', exported.target === openTarget);
    item.append(
      make('span', 'asset-name', exported.target),
      make('span', 'asset-sub', exported.dir),
    );
    item.addEventListener('click', () => void ctx.loadExport(exported.target));
    exports.appendChild(item);
  }
  rail.appendChild(exports);

  rail.appendChild(validationPanel(ctx));
}

/** The whole-store check: one button, and whatever it last reported. */
function validationPanel(ctx: WorkbenchContext): HTMLElement {
  const section = make('section', 'validation');
  section.dataset.validationPanel = '';
  section.appendChild(subheading('Store check'));

  const button = make('button', 'btn small', 'Validate store') as HTMLButtonElement;
  button.dataset.validateRun = '';
  button.addEventListener('click', () => {
    void ctx.run('Validate store', async () => {
      ctx.state.validation = await ctx.api.validateStore();
      ctx.renderLibrary();
      ctx.renderStage();
      ctx.renderInspector();
    });
  });
  section.appendChild(button);

  const report = ctx.state.validation;
  if (!report) {
    return section;
  }
  const lines = make('ul', 'validation-list');
  lines.dataset.validationReport = String(report.ok);
  if (report.problems.length === 0) {
    lines.appendChild(make('li', 'muted', 'Every artifact validates.'));
  }
  for (const problem of report.problems) {
    const item = make('li', 'warning');
    item.dataset.validationProblem = problem.path;
    item.textContent = `${problem.path}: ${problem.message}`;
    lines.appendChild(item);
  }
  section.appendChild(lines);
  return section;
}
