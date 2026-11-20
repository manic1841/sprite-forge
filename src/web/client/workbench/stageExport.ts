/**
 * The Export stage: the loaded Manifest's summary and the Export form.
 *
 * No export logic lives here — the bindings go straight to the API, which the
 * server turns into the `exportCharacter` core verb. The form covers the whole
 * closed contract (`docs/export-contract.md`): the animation subset, the
 * consumer's Situations **and** the Situation→animation bindings in one list, the
 * Facing-flipping animations, and the authored Facing.
 *
 * Situations used to be two fields — a comma list of names and a JSON box of
 * bindings — which meant typing every Situation twice and discovering the
 * mismatches at submit. They are one row each now: the row *is* the declaration,
 * and its chips are drawn from the animations actually ticked, so the request body
 * is derived and the contract's closure is something the form can check as you
 * type.
 */

import type { BasePort } from './ports.js';
import { make } from './dom.js';
import type { ExportForm, ExportSituation } from './state.js';
import type { ExportBindings, Facing } from '../types.js';

/** Render the export face for the loaded target (or the form alone). */
export function exportStageView(ctx: BasePort): HTMLElement {
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
          `situations: ${Object.keys(manifest.bindings).join(', ') || 'none'}`,
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
function exportForm(ctx: BasePort): HTMLElement {
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
  const animationRow = make('fieldset', 'field choices export-animations');
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

  const flipRow = make('fieldset', 'field choices export-flips');
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

  const situationsRow = make('fieldset', 'field situations-field export-situations');
  situationsRow.append(make('legend', 'k', 'situations'));
  situationsRow.dataset.exportSituations = '';
  // The consumer declares its own names, so this is a hint list rather than a
  // closed set: the contract's own vocabulary, which is what a first Export most
  // often needs.
  const names = document.createElement('datalist');
  names.id = 'situation-names';
  for (const name of ['idle', 'happy', 'nod', 'alert', 'walk', 'sleep']) {
    const option = document.createElement('option');
    option.value = name;
    names.appendChild(option);
  }
  situationsRow.appendChild(names);
  situationsRow.appendChild(
    make(
      'p',
      'field-hint',
      'Each Situation the consumer declares, and which exported animations may play for it. ' +
        'Nothing outside these rows is sent.',
    ),
  );
  const list = make('ul', 'situation-list');
  list.dataset.exportSituationList = '';
  situationsRow.appendChild(list);
  // Rebuilt when the *set* of rows changes; a problem note is written in place, so
  // typing a name does not lose the caret.
  const paintList = (): void => {
    list.innerHTML = '';
    values.situations.forEach((situation, index) => {
      list.appendChild(situationRow(values, situation, index, paintList));
    });
    if (values.situations.length === 0) {
      list.appendChild(make('li', 'muted', 'No Situation yet — add the ones this target shows.'));
    }
    refreshProblems();
  };

  /** Say what is still wrong with each row, in place. */
  const refreshProblems = (): void => {
    for (const item of list.querySelectorAll<HTMLElement>('[data-export-situation]')) {
      const situation = values.situations[Number(item.dataset.exportSituation)];
      const text = situation === undefined ? '' : (situationProblems(values, situation)[0] ?? '');
      const existing = item.querySelector<HTMLElement>('[data-export-situation-problem]');
      if (text === '') {
        existing?.remove();
      } else if (existing !== null) {
        existing.textContent = text;
      } else {
        const note = make('p', 'situation-problem', text);
        note.dataset.exportSituationProblem = '';
        item.appendChild(note);
      }
    }
  };

  paintList();
  const addSituation = make('button', 'btn small ghost', '+ Situation') as HTMLButtonElement;
  addSituation.type = 'button';
  addSituation.dataset.exportSituationAdd = '';
  addSituation.addEventListener('click', () => {
    values.situations = [...values.situations, { name: '', ids: [] }];
    paintList();
  });
  situationsRow.appendChild(addSituation);

  // The request body's own shape, read back: the JSON is derived now, never typed,
  // so it cannot drift from the rows. It stays visible for the CLI's sake.
  const preview = document.createElement('details');
  preview.className = 'bindings-preview export-bindings';
  preview.appendChild(make('summary', 'muted', 'bindings JSON'));
  const pre = document.createElement('pre');
  pre.dataset.exportBindings = '';
  preview.appendChild(pre);

  const button = make('button', 'btn', 'Export') as HTMLButtonElement;
  button.type = 'submit';
  button.dataset.exportRun = '';
  const message = make('p', 'muted');
  message.dataset.exportMessage = '';

  // Keep the derived JSON, the row notes and the button in step with every edit,
  // wherever it came from.
  const syncPreview = (): void => {
    // The target is read back on every sync as well: a reload can restore the field
    // from the browser's own memory without an `input` event, and state has to
    // agree with what is on screen before the closure is judged.
    values.target = targetInput.value;
    const problems = problemsOf(values);
    pre.textContent = JSON.stringify(bindingsOf(values.situations), null, 2);
    button.disabled = problems.length > 0;
    message.textContent = problems[0] ?? '';
    refreshProblems();
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // Read the fields straight from the DOM: a programmatic value set (or a paste
    // that skipped `input`) must not be able to look like an empty form.
    values.target = targetInput.value;
    values.authoredFacing = facingSelect.value as Facing;
    // A disabled button is cosmetic to `requestSubmit()`, so the rule is enforced
    // here too: the Export is closed or it does not run.
    const problems = problemsOf(values);
    if (problems.length > 0) {
      message.textContent = problems[0]!;
      refreshProblems();
      return;
    }
    void ctx.run('Export', () => runExport(ctx, characterSelect.value, values, message));
  });

  // A tick in the animation list changes what a Situation may bind to, so the rows
  // are redrawn too: a chip is only ever offered for something being exported.
  animationRow.addEventListener('change', () => {
    paintList();
    syncPreview();
  });
  characterSelect.addEventListener('change', () => ctx.renderStage());
  form.addEventListener('input', syncPreview);
  form.addEventListener('change', syncPreview);
  form.addEventListener('click', syncPreview);
  syncPreview();

  // The identifying fields share one row so the two columns below can be about the
  // bundle's *content* rather than about which Character it is.
  const identity = make('div', 'export-identity');
  identity.append(characterRow, targetRow, facingRow);
  const actions = make('div', 'export-actions');
  actions.append(button, message);

  form.append(identity, animationRow, flipRow, situationsRow, preview, actions);
  return form;
}

/**
 * One Situation: its name, and a chip per exported animation.
 *
 * The chips are the animations actually ticked above, so a binding can only name
 * something that will be in the Export. An id that *was* bound and has since been
 * unticked stays as a struck-through chip instead of vanishing — retick it and the
 * binding is back.
 */
function situationRow(
  values: ExportForm,
  situation: ExportSituation,
  index: number,
  repaint: () => void,
): HTMLElement {
  const item = make('li', 'situation');
  item.dataset.exportSituation = String(index);

  const name = document.createElement('input');
  name.className = 'situation-name';
  name.dataset.exportSituationName = '';
  name.value = situation.name;
  name.placeholder = 'situation';
  name.setAttribute('list', 'situation-names');
  name.setAttribute('aria-label', `Situation ${index + 1}`);
  name.addEventListener('input', () => {
    situation.name = name.value;
  });
  item.appendChild(name);

  const bound = new Set(situation.ids);
  const choices = make('div', 'situation-ids');
  choices.dataset.exportSituationIds = '';
  if (values.animations.length === 0) {
    choices.appendChild(make('span', 'muted', 'tick an animation to bind it'));
  }
  for (const asset of values.animations) {
    const chip = make('button', 'chip', asset) as HTMLButtonElement;
    chip.type = 'button';
    chip.dataset.exportSituationBind = asset;
    const on = bound.has(asset);
    chip.setAttribute('aria-pressed', String(on));
    chip.title = on ? `Unbind ${asset}` : `Bind ${asset}`;
    if (on) {
      chip.dataset.active = '';
    }
    chip.addEventListener('click', () => {
      situation.ids = on ? situation.ids.filter((id) => id !== asset) : [...situation.ids, asset];
      repaint();
    });
    choices.appendChild(chip);
  }
  // Bound, then unticked: still a real reference, but not in the Export as it
  // stands — so it is kept and marked rather than dropped behind the user.
  for (const id of situation.ids.filter((entry) => !values.animations.includes(entry))) {
    const chip = make('button', 'chip stale', id) as HTMLButtonElement;
    chip.type = 'button';
    chip.dataset.exportSituationBind = id;
    chip.dataset.stale = '';
    chip.setAttribute('aria-pressed', 'true');
    chip.title = `${id} is bound here but not exported`;
    chip.addEventListener('click', () => {
      situation.ids = situation.ids.filter((entry) => entry !== id);
      repaint();
    });
    choices.appendChild(chip);
  }
  item.appendChild(choices);

  const remove = make('button', 'btn small ghost', '✕') as HTMLButtonElement;
  remove.type = 'button';
  remove.dataset.exportSituationRemove = '';
  remove.title = `Remove the "${situation.name || 'unnamed'}" Situation`;
  remove.setAttribute('aria-label', `Remove the "${situation.name || 'unnamed'}" Situation`);
  remove.addEventListener('click', () => {
    values.situations = values.situations.filter((_, at) => at !== index);
    repaint();
  });
  item.appendChild(remove);
  return item;
}

/** The rows as the request body wants them: a name-keyed map of id lists. */
function bindingsOf(situations: ExportSituation[]): ExportBindings {
  const bindings: ExportBindings = {};
  for (const situation of situations) {
    if (situation.name !== '') {
      bindings[situation.name] = [...situation.ids];
    }
  }
  return bindings;
}

/**
 * What still stands between this form and a closed Export.
 *
 * The same rules the server enforces, said while typing instead of after a round
 * trip: the contract's closure is a property of *these rows*, so it can be checked
 * as they are edited. The first problem is the one shown, so a submit is never a
 * surprise.
 */
function problemsOf(values: ExportForm): string[] {
  const problems: string[] = [];
  if (values.target === '') {
    problems.push('a target is required');
  }
  for (const situation of values.situations) {
    problems.push(...situationProblems(values, situation));
  }
  return problems;
}

/**
 * What is wrong with one row, in the row's own words.
 *
 * A row is checked for its name first, then for what it binds: a row with neither
 * reports the name, so a fresh `+ Situation` asks for the thing to type rather than
 * lecturing about a binding it could not have chosen yet.
 */
function situationProblems(values: ExportForm, situation: ExportSituation): string[] {
  const problems: string[] = [];
  if (situation.name === '') {
    problems.push('this Situation needs a name');
    return problems;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(situation.name)) {
    problems.push(`"${situation.name}" must be lowercase letters, digits and dashes, from a letter`);
  } else if (values.situations.filter((entry) => entry.name === situation.name).length > 1) {
    problems.push(`"${situation.name}" is declared twice`);
  }
  if (situation.ids.length === 0) {
    problems.push(`"${situation.name}" needs at least one animation`);
  }
  for (const id of situation.ids) {
    if (!values.animations.includes(id)) {
      problems.push(`"${id}" is bound here but not exported`);
    }
  }
  return problems;
}

/** Every committed Asset id of a Character, for the checkbox lists. */
function committedIds(ctx: BasePort, characterId: string): string[] {
  const character = ctx.state.scan?.characters.find((candidate) => candidate.id === characterId);
  return (character?.assets ?? []).map((asset) => asset.id);
}

/** Add or remove a value, returning a new array so state stays replacement-only. */
function toggle(list: string[], value: string, on: boolean): string[] {
  return on ? [...new Set([...list, value])] : list.filter((entry) => entry !== value);
}

async function runExport(
  ctx: BasePort,
  characterId: string,
  values: ExportForm,
  message: HTMLElement,
): Promise<void> {
  const bindings = bindingsOf(values.situations);
  const situations = Object.keys(bindings);
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