/**
 * The Library rail: the store, laid out in the order its levels depend on.
 *
 * A **Character** comes first because work starts there: it owns both the
 * Canvas/Anchor and everything made for it — its Drafts and its committed Assets
 * — so those nest *inside* their Character rather than sitting in separate flat
 * sections beside it. A Recording is source material fed into a Character, so it
 * follows and carries its own Segments the same way. Exports close the list: they
 * are produced from a Character, not held by one.
 *
 * The rail is an index, so it carries only what identifies an item: a name, and a
 * count for the section holding it. Paths, kinds and forms are all demoted — the
 * two forms that *add* to the store open from a `+` in their section header. Only
 * the open Character and the open Recording are expanded, which is what keeps a
 * desktop window free of scrolling however much the store holds.
 */

import type { LibraryPort } from './ports.js';
import { characterSection } from './characters.js';
import { heading, make, railSection } from './dom.js';
import { importForm } from './importForm.js';
import { activeCharacter, activeExport } from './state.js';
import type { Segment } from '../types.js';

/** Render the rail from the latest scan. */
export function renderLibrary(ctx: LibraryPort): void {
  const { rail } = ctx.regions;
  const { state } = ctx;

  // Both open levels are read before the rail is cleared: they derive from the
  // target, and the rail is rebuilt from scratch below.
  // The rail holds one open branch at a time: a Recording and a Character are
  // alternate subjects, so focusing either collapses the other and leaving both
  // collapses both. The cut list is source material, not a standing expansion, so
  // it is opened by its own row rather than by the Recording being loaded.
  const openRecording =
    state.target.kind === 'recording' && state.railOpenRecording === state.target.recordingId
      ? state.target.recordingId
      : null;
  const openCharacter = openRecording === null ? activeCharacter(state) : null;
  const openExport = activeExport(state);
  const recordings = state.scan?.recordings ?? [];
  const characters = state.scan?.characters ?? [];
  const exports = state.scan?.exports ?? [];

  rail.innerHTML = '';
  rail.appendChild(heading('Library'));

  // Characters come first: a Character is the level work starts from, and a
  // Recording is source material fed *into* one.
  rail.appendChild(
    railSection({
      title: 'Characters',
      count: characters.length === 0 ? undefined : characters.length,
      add: {
        label: 'New Character',
        attribute: 'railCharacterAdd',
        onClick: () => openForm(ctx, 'character'),
      },
    }),
  );
  rail.appendChild(characterSection(ctx, openCharacter));

  // Recordings: source material, with Import behind its `+`.
  rail.appendChild(
    railSection({
      title: 'Recordings',
      count: recordings.length === 0 ? undefined : recordings.length,
      add: {
        label: 'Import a Recording',
        attribute: 'railImportAdd',
        onClick: () => openForm(ctx, 'import'),
      },
    }),
  );
  if (state.railForm === 'import') {
    rail.appendChild(importForm(ctx));
  }
  if (recordings.length === 0 && state.railForm !== 'import') {
    rail.appendChild(make('p', 'rail-empty', 'no Recordings yet'));
  }
  rail.appendChild(recordingSection(ctx, openRecording));

  rail.appendChild(
    railSection({ title: 'Exports', count: exports.length === 0 ? undefined : exports.length }),
  );
  if (exports.length === 0) {
    rail.appendChild(make('p', 'rail-empty', 'nothing exported yet'));
  }
  rail.appendChild(itemList('exports', exports, (exported) => {
    const item = make('button', 'asset');
    item.dataset.exportTarget = exported.target;
    item.classList.toggle('sel', exported.target === openExport);
    item.appendChild(make('span', 'asset-name', exported.target));
    item.addEventListener('click', () => void ctx.loadExport(exported.target));
    return item;
  }));

  rail.appendChild(validationPanel(ctx));
}

/** Open one of the rail's create forms, closing the other. */
function openForm(ctx: LibraryPort, form: 'import' | 'character'): void {
  ctx.state.railForm = ctx.state.railForm === form ? 'none' : form;
  ctx.renderLibrary();
}

/** A section's rows, built by `row` and tagged with the section they belong to. */
function itemList<T>(
  section: string,
  entries: readonly T[],
  row: (entry: T) => HTMLElement,
): HTMLElement {
  const list = make('div', 'list');
  list.dataset.librarySection = section;
  for (const entry of entries) {
    list.appendChild(row(entry));
  }
  return list;
}

/**
 * The Recordings: each one a row, and — while it is open — the Segments cut from
 * it.
 *
 * This mirrors the Characters section because the shape is the same: a Recording
 * owns its cut list (ADR-0007), so its Segments nest under it and appear only
 * while it is open. A Segment row **selects** rather than loads: the Recording is
 * already on screen, and reloading it would reset the playhead and the mark.
 */
function recordingSection(ctx: LibraryPort, open: string | null): HTMLElement {
  const selected = ctx.state.target.kind === 'recording' ? ctx.state.target.recordingId : null;
  const list = make('div', 'list');
  list.dataset.librarySection = 'recordings';
  for (const recording of ctx.state.scan?.recordings ?? []) {
    list.appendChild(recordingGroup(ctx, recording.id, recording.id === open, recording.id === selected));
  }
  return list;
}

/** One Recording, and its Segments while it is the open one. */
function recordingGroup(
  ctx: LibraryPort,
  recordingId: string,
  open: boolean,
  selected: boolean,
): HTMLElement {
  // The cut list is only held for the open Recording, so the count is too.
  const cuts = open ? (ctx.state.cutList?.cuts ?? []) : [];
  const group = make('div', 'char-group');
  group.dataset.recordingGroup = recordingId;

  const head = make('button', 'asset char-head') as HTMLButtonElement;
  head.dataset.recording = recordingId;
  head.setAttribute('aria-expanded', String(open));
  head.classList.toggle('sel', selected);
  head.classList.toggle('open', open);
  const chevron = make('span', 'chev', open ? '▾' : '▸');
  chevron.setAttribute('aria-hidden', 'true');
  head.append(
    chevron,
    make('span', 'asset-name', recordingId),
    make('span', 'rail-count', open ? String(cuts.length) : ''),
  );
  head.addEventListener('click', () => {
    // The row is also the branch's disclosure: pressing the one already open folds
    // it away again rather than re-loading into an unchanged screen.
    ctx.state.railOpenRecording =
      ctx.state.railOpenRecording === recordingId ? null : recordingId;
    void ctx.loadRecording(recordingId);
  });
  group.appendChild(head);

  if (open) {
    group.appendChild(recordingContents(ctx, recordingId, cuts));
  }
  return group;
}

/** The open Recording's Segments, as a nested branch. */
function recordingContents(
  ctx: LibraryPort,
  recordingId: string,
  cuts: readonly Segment[],
): HTMLElement {
  const body = make('div', 'char-body');
  const branch = make('div', 'char-branch');
  branch.dataset.charBranch = 'segments';
  branch.appendChild(make('h4', 'ttl grp', 'Segments'));

  if (cuts.length === 0) {
    branch.appendChild(make('p', 'rail-empty', 'none yet — mark a range on the strip'));
    body.appendChild(branch);
    return body;
  }

  const list = make('div', 'list');
  for (const segment of cuts) {
    const item = make('button', 'asset');
    item.dataset.segment = segment.id;
    item.dataset.segmentRecording = recordingId;
    item.classList.toggle('sel', segment.id === ctx.state.selectedCut);
    item.append(
      make('span', 'asset-name', segment.id),
      make('span', 'asset-sub', `[${segment.startFrame}, ${segment.endFrame})`),
    );
    item.addEventListener('click', () => ctx.cut.selectSegment(segment));
    list.appendChild(item);
  }
  branch.appendChild(list);
  body.appendChild(branch);
  return body;
}


/** The whole-store check, as one quiet footer line until it has something to say. */
function validationPanel(ctx: LibraryPort): HTMLElement {
  const section = make('div', 'rail-foot');
  section.dataset.validationPanel = '';

  const button = make('button', 'rail-foot-btn', 'Validate store') as HTMLButtonElement;
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
  section.appendChild(
    make('p', 'rail-foot-note', report.problems.length === 0 ? 'every artifact validates' : ''),
  );
  if (report.problems.length === 0) {
    section.dataset.validationReport = 'true';
    return section;
  }
  section.dataset.validationReport = 'false';
  const lines = make('ul', 'validation-list');
  for (const problem of report.problems) {
    const item = make('li', 'warning');
    item.dataset.validationProblem = problem.path;
    item.textContent = `${problem.path}: ${problem.message}`;
    lines.appendChild(item);
  }
  section.appendChild(lines);
  return section;
}
