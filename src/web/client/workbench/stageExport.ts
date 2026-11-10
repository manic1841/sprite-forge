/**
 * The Export stage: the loaded Manifest's summary and the Export form.
 *
 * No export logic lives here — the bindings go straight to the API, which the
 * server turns into the `exportCharacter` core verb. The form covers the whole
 * closed contract (`docs/export-contract.md`): the animation subset, the
 * consumer's Situations, the Facing-flipping animations, the authored Facing,
 * and the Situation→animation bindings.
 */

import type { WorkbenchContext } from './context.js';
import { make } from './dom.js';
import type { ExportForm } from './state.js';
import type { ExportBindings, Facing } from '../types.js';

/** Render the export face for the loaded target (or the form alone). */
export function exportStageView(ctx: WorkbenchContext): HTMLElement {
  const view = make('div', 'stage-view');
  view.dataset.stageView = 'export';

  const manifest = ctx.state.manifest?.manifest ?? null;
  const summary = make('div', 'export-summary');
  summary.dataset.exportSummary = '';
  if (manifest) {
    summary.append(
      make('p', 'ttl', `${manifest.target} · ${manifest.character}`),
      make(
        'p',
        'muted',
        `${Object.keys(manifest.animations).length} animation(s) · ` +
          `canvas ${manifest.canvas.width}×${manifest.canvas.height} · ` +
          `authored ${manifest.authoredFacing} · ` +
          `bindings: ${Object.keys(manifest.bindings).join(', ') || 'none'}`,
      ),
    );
  } else {
    summary.appendChild(
      make('p', 'muted', 'Export — select an Export in the Library, or run one below.'),
    );
  }
  view.append(summary, exportForm(ctx));
  return view;
}

/** Build the Export form, restoring whatever the user already typed. */
function exportForm(ctx: WorkbenchContext): HTMLElement {
  const form = make('form', 'export-form');
  form.dataset.exportForm = '';
  const values = ctx.state.exportForm;

  const characterRow = make('label', 'field');
  characterRow.append(make('span', 'k', 'character'));
  const characterSelect = document.createElement('select');
  characterSelect.dataset.exportCharacter = '';
  for (const character of ctx.state.scan?.characters ?? []) {
    const option = document.createElement('option');
    option.value = character.id;
    option.textContent = character.id;
    characterSelect.appendChild(option);
  }
  characterRow.appendChild(characterSelect);
  // The Character in play wins, so an Export follows the work you were just doing.
  if (ctx.state.activeCharacterId) {
    characterSelect.value = ctx.state.activeCharacterId;
  }

  const targetRow = make('label', 'field');
  targetRow.append(make('span', 'k', 'target'));
  const targetInput = document.createElement('input');
  targetInput.dataset.exportTargetInput = '';
  targetInput.placeholder = 'pixel-pet';
  targetInput.value = values.target;
  targetInput.addEventListener('input', () => {
    values.target = targetInput.value;
  });
  targetRow.appendChild(targetInput);

  const committed = committedIds(ctx, characterSelect.value);
  const animationRow = make('fieldset', 'field choices');
  animationRow.append(make('legend', 'k', 'animations'));
  animationRow.dataset.exportAnimations = '';
  if (committed.length === 0) {
    animationRow.appendChild(make('p', 'muted', 'This Character has no committed assets.'));
  }
  for (const asset of committed) {
    const box = document.createElement('label');
    box.className = 'choice';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = asset;
    input.dataset.exportAnimation = asset;
    input.checked = values.animations.includes(asset);
    input.addEventListener('change', () => {
      values.animations = toggle(values.animations, asset, input.checked);
    });
    box.append(input, make('span', undefined, asset));
    animationRow.appendChild(box);
  }

  const flipRow = make('fieldset', 'field choices');
  flipRow.append(make('legend', 'k', 'flips facing'));
  flipRow.dataset.exportFlips = '';
  for (const asset of committed) {
    const box = document.createElement('label');
    box.className = 'choice';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = asset;
    input.dataset.exportFlip = asset;
    input.checked = values.flipsFacing.includes(asset);
    input.addEventListener('change', () => {
      values.flipsFacing = toggle(values.flipsFacing, asset, input.checked);
    });
    box.append(input, make('span', undefined, asset));
    flipRow.appendChild(box);
  }

  const facingRow = make('label', 'field');
  facingRow.append(make('span', 'k', 'authored facing'));
  const facingSelect = document.createElement('select');
  facingSelect.dataset.exportFacing = '';
  for (const facing of ['right', 'left'] as const) {
    const option = document.createElement('option');
    option.value = facing;
    option.textContent = facing;
    option.selected = values.authoredFacing === facing;
    facingSelect.appendChild(option);
  }
  facingSelect.addEventListener('change', () => {
    values.authoredFacing = facingSelect.value as Facing;
  });
  facingRow.appendChild(facingSelect);

  const situationsRow = make('label', 'field');
  situationsRow.append(make('span', 'k', 'situations'));
  const situationsInput = document.createElement('input');
  situationsInput.dataset.exportSituations = '';
  situationsInput.placeholder = 'idle, walk';
  situationsInput.value = values.situations;
  situationsInput.addEventListener('input', () => {
    values.situations = situationsInput.value;
  });
  situationsRow.append(situationsInput, make('span', 'muted', 'comma separated'));

  const bindingsRow = make('label', 'field');
  bindingsRow.append(make('span', 'k', 'bindings'));
  const bindingsInput = document.createElement('textarea');
  bindingsInput.dataset.exportBindings = '';
  bindingsInput.rows = 3;
  bindingsInput.value = values.bindings;
  bindingsInput.addEventListener('input', () => {
    values.bindings = bindingsInput.value;
  });
  bindingsRow.appendChild(bindingsInput);

  const button = make('button', 'btn', 'Export') as HTMLButtonElement;
  button.type = 'submit';
  button.dataset.exportRun = '';
  const message = make('p', 'muted');
  message.dataset.exportMessage = '';

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // Read the fields straight from the DOM: a programmatic value set (or a paste
    // that skipped `input`) must not be able to look like an empty form.
    values.target = targetInput.value;
    values.situations = situationsInput.value;
    values.bindings = bindingsInput.value;
    values.authoredFacing = facingSelect.value as Facing;
    void ctx.run('Export', () => runExport(ctx, characterSelect.value, values, message));
  });

  form.append(
    characterRow,
    targetRow,
    animationRow,
    flipRow,
    facingRow,
    situationsRow,
    bindingsRow,
    button,
    message,
  );
  return form;
}

/** Every committed Asset id of a Character, for the checkbox lists. */
function committedIds(ctx: WorkbenchContext, characterId: string): string[] {
  const character = ctx.state.scan?.characters.find((candidate) => candidate.id === characterId);
  return (character?.assets ?? []).map((asset) => asset.id);
}

/** Add or remove a value, returning a new array so state stays replacement-only. */
function toggle(list: string[], value: string, on: boolean): string[] {
  return on ? [...new Set([...list, value])] : list.filter((entry) => entry !== value);
}

async function runExport(
  ctx: WorkbenchContext,
  characterId: string,
  values: ExportForm,
  message: HTMLElement,
): Promise<void> {
  if (!characterId || !values.target) {
    message.textContent = 'character and target are required';
    return;
  }
  let bindings: ExportBindings;
  try {
    bindings = JSON.parse(values.bindings) as ExportBindings;
  } catch {
    message.textContent = 'bindings must be valid JSON';
    return;
  }
  const situations = values.situations
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const result = await ctx.api.exportCharacter(characterId, values.target, {
    bindings,
    ...(values.animations.length > 0 ? { animations: values.animations } : {}),
    ...(situations.length > 0 ? { situations } : {}),
    ...(values.flipsFacing.length > 0 ? { flipsFacing: values.flipsFacing } : {}),
    authoredFacing: values.authoredFacing,
  });
  ctx.state.target = { kind: 'export', target: values.target };
  ctx.state.manifest = result;
  ctx.state.loadError = null;
  message.textContent = `exported ${values.target}`;
  await ctx.rescan();
  ctx.renderStage();
  ctx.renderInspector();
}
