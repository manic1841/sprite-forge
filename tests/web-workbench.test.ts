// @vitest-environment jsdom
//
// DOM-level smoke tests for the workbench shell. They pin the **structural
// contract** later tickets depend on: the four persistent regions, the mode
// switch that swaps the stage while the other regions keep their node identity,
// the Library list derived from a store scan, the filmstrip's frame cells + cut
// ranges, and — from #26 — the Clip editor stage showing a Draft's frames with a
// contextual inspector. Behaviour that cannot be pinned structurally (dragging a
// range edge, real painting) is verified by running `pnpm web` against a temp store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountWorkbench, slugifyId } from '../src/web/client/app.js';
import { clampRange } from '../src/web/client/timeline.js';
import { draftScaleFor as draftScale } from '../src/web/client/workbench/draftEditor.js';
import type { WorkbenchApi } from '../src/web/client/api.js';
import type {
  AlignmentState,
  CharacterAlignment,
  ClipDraft,
  CommittedAsset,
  CommittedSequence,
  CreatedCharacter,
  CutList,
  DerivedAnchor,
  ExportResult,
  RepairState,
  SequenceFork,
  StoreScan,
} from '../src/web/client/types.js';

const SCAN: StoreScan = {
  root: '/tmp/store',
  recordings: [
    { id: 'idle', dir: 'recordings/idle' },
    { id: 'fat-walk', dir: 'recordings/fat-walk' },
  ],
  characters: [
    {
      id: 'hero',
      dir: 'characters/hero',
      assets: [
        { kind: 'clip', id: 'walk', dir: 'characters/hero/clips/walk' },
        { kind: 'sequence', id: 'greeting', dir: 'characters/hero/sequences/greeting' },
      ],
      drafts: [{ id: 'wip', dir: 'characters/hero/drafts/wip' }],
      sequenceDrafts: [],
    },
  ],
  exports: [],
};

const CUTS: CutList = {
  hash: `sha256:${'a'.repeat(64)}`,
  frameCount: 8,
  cuts: [
    { id: 'walk', startFrame: 1, endFrame: 4 },
    { id: 'turn', startFrame: 5, endFrame: 8, speed: 2 },
  ],
};

const DRAFT: ClipDraft = {
  id: 'wip',
  characterId: 'hero',
  recordingId: 'idle',
  recordingHash: `sha256:${'a'.repeat(64)}`,
  segment: { cutId: 'walk', startFrame: 1, endFrame: 4, speed: 1 },
  background: { hex: '#9421ce', source: 'sampled', tolerance: 24 },
  frameCount: 3,
  delaysMs: [50, 60, 70],
  loop: true,
  spriteForgeVersion: '0.1.0',
  dir: 'characters/hero/drafts/wip',
  frames: [
    'characters/hero/drafts/wip/frames/000.png',
    'characters/hero/drafts/wip/frames/001.png',
    'characters/hero/drafts/wip/frames/002.png',
  ],
};

/** A stub API standing in for the HTTP boundary; the UI only ever talks to this. */
function fakeApi(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  return {
    scan: async () => SCAN,
    ingestRecording: async (id) => ({
      id,
      dir: `recordings/${id}`,
      hash: `sha256:${'b'.repeat(64)}`,
      frameCount: 4,
      delaysMs: [50, 50, 60, 50],
    }),
    readCutList: async () => CUTS,
    readRecordingDelays: async (recordingId) => ({
      recordingId,
      delaysMs: [50, 50, 60, 50, 50, 50, 50, 50],
    }),
    addSegment: async () => CUTS,
    setSegmentRange: async () => CUTS,
    setSegmentRect: async () => CUTS,
    segmentContentBounds: async () => ({ x: 1, y: 1, width: 2, height: 2 }),
    removeSegment: async () => CUTS,
    renameSegment: async () => CUTS,
    recordingFrameUrl: (recordingId, index) =>
      `/api/recordings/${recordingId}/frames/${index}`,
    readClipDraft: async () => DRAFT,
    extractClipDraft: async () => DRAFT,
    commitDraft: async (characterId, draftId, name) =>
      ({
        kind: 'clip',
        id: name,
        dir: `characters/${characterId}/clips/${name}`,
      }) as unknown as CommittedAsset,
    deriveAnchor: async () =>
      ({
        frame: 0,
        bounds: { x: 0, y: 0, width: 4, height: 6 },
        anchor: { x: 2, y: 6 },
        canvas: { width: 4, height: 6, anchor: { x: 2, y: 6 } },
      }) as DerivedAnchor,
    createCharacter: async (id) =>
      ({ id, dir: `characters/${id}` }) as unknown as CreatedCharacter,
    frameUrl: (characterId, draftId, index) =>
      `/api/characters/${characterId}/drafts/${draftId}/frames/${index}`,
    readRepair: async () => EMPTY_REPAIR,
    appendRepairOperation: async () => EMPTY_REPAIR,
    undoRepairOperation: async () => EMPTY_REPAIR,
    sampleRepairColor: async () => '#ff0000',
    readCharacterAlignment: async () => ALIGNMENT,
    readDraftAlignment: async () => EMPTY_ALIGNMENT,
    setPlacementOffset: async () => DRAFT,
    setFlipX: async () => DRAFT,
    resizeCanvas: async () => ({
      canvas: ALIGNMENT.canvas,
      rebakedClips: [],
      rebakedSequences: [],
      repairWarnings: [],
    }),
    fitCanvas: async () => ({
      canvas: ALIGNMENT.canvas,
      rebakedClips: [],
      rebakedSequences: [],
      repairWarnings: [],
    }),
    frameCanvas: async () => ALIGNMENT.canvas,
    sheetUrl: (characterId, kind, id) =>
      `/api/characters/${characterId}/${kind === 'clip' ? 'clips' : 'sequences'}/${id}/sheet`,
    exportCharacter: async () => EXPORT_RESULT,
    readManifest: async () => EXPORT_RESULT,
    readClip: async () => CLIP,
    readSequence: async () => SEQUENCE,
    forkClip: async () => DRAFT,
    forkSequence: async () => SEQUENCE_FORK,
    listSequenceDrafts: async () => ({ drafts: [] }),
    readSequenceDraft: async (characterId, draftId) => ({
      id: draftId,
      characterId,
      clips: [],
      forkOf: null,
      spriteForgeVersion: '0.1.0',
      dir: `characters/${characterId}/sequence-drafts/${draftId}`,
    }),
    saveSequenceDraft: async (characterId, request) => ({
      id: request.draftId ?? 'composition',
      characterId,
      clips: [...request.clips],
      forkOf: request.forkOf ?? null,
      spriteForgeVersion: '0.1.0',
      dir: `characters/${characterId}/sequence-drafts/${request.draftId ?? 'composition'}`,
    }),
    discardSequenceDraft: async () => {},
    commitSequence: async (characterId, sequenceId, clips) => ({
      ...SEQUENCE,
      id: sequenceId,
      dir: `characters/${characterId}/sequences/${sequenceId}`,
      provenance: { ...SEQUENCE.provenance, clips },
    }),
    discardDraft: async () => {},
    deleteAsset: async () => {},
    verifyReproducible: async (characterId, kind, id) => ({
      kind,
      id,
      reproducible: true,
      artifacts: [`characters/${characterId}/clips/${id}/sheet.png`],
      excluded: [],
      mismatches: [],
    }),
    validateStore: async () => ({
      ok: true,
      root: '/tmp/store',
      artifactCount: 0,
      problems: [],
    }),
    ...overrides,
  };
}

/** A valid ExportResult for the Export stage's "live manifest". */
const EXPORT_RESULT: ExportResult = {
  target: 'pixel-pet',
  manifestPath: 'exports/pixel-pet/manifest.json',
  sheetPaths: ['exports/pixel-pet/clips/walk.png'],
  manifest: {
    formatVersion: '1.0.0',
    target: 'pixel-pet',
    character: 'hero',
    authoredFacing: 'right',
    canvas: { width: 4, height: 6, anchor: { x: 2, y: 6 } },
    animations: {
      walk: { sheet: 'clips/walk.png', frameCount: 3, delaysMs: [50], loop: true },
    },
    bindings: { idle: ['walk'] },
    lock: { spriteForgeVersion: '0.1.0', exportedAt: '2026-10-08T00:00:00.000Z' },
  },
};

const EMPTY_REPAIR: RepairState = { operations: [], warnings: [] };

/** A committed Clip as the asset inspector reads it. */
const CLIP: CommittedAsset = {
  kind: 'clip',
  id: 'walk',
  dir: 'characters/hero/clips/walk',
  meta: { id: 'walk', frameCount: 3, delaysMs: [50], loop: true },
  provenance: {
    recordingId: 'idle',
    recordingHash: `sha256:${'a'.repeat(64)}`,
    segment: { cutId: 'walk', startFrame: 1, endFrame: 4, speed: 1 },
    background: { hex: '#9421ce', source: 'sampled', tolerance: 24 },
    repair: null,
    derivedFrom: null,
    spriteForgeVersion: '0.1.0',
  },
};

/** A committed Sequence and its fork, as the sequence stage reads them. */
const SEQUENCE: CommittedSequence = {
  kind: 'sequence',
  id: 'walk-jump',
  dir: 'characters/hero/sequences/walk-jump',
  meta: { id: 'walk-jump', frameCount: 6, delaysMs: [50], loop: false },
  provenance: { clips: ['walk', 'greeting'], derivedFrom: null, spriteForgeVersion: '0.1.0' },
};

const SEQUENCE_FORK: SequenceFork = {
  kind: 'sequence',
  id: 'walk-jump',
  clips: ['walk', 'greeting'],
  derivedFrom: { kind: 'sequence', id: 'walk-jump' },
};const EMPTY_ALIGNMENT: AlignmentState = { offset: { x: 0, y: 0 }, flipX: false, warnings: [] };
const ALIGNMENT: CharacterAlignment = {
  canvas: { width: 4, height: 6, anchor: { x: 2, y: 6 } },
  contentFloor: { width: 4, height: 6, hasContent: true },
  clips: [{ id: 'walk', frameCount: 3, placementOffset: { x: 0, y: -1 } }],
  drafts: [{ id: 'wip' }],
};

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

/**
 * Answer the in-page dialog.
 *
 * The workbench does not use `window.confirm`/`prompt` — the embedded browser
 * throws on `prompt()` — so a confirmation is a node to click. It is appended
 * synchronously by the click that raised it, so this may follow that click
 * immediately; the action's own promise still needs `settled()` afterwards.
 *
 * `value` fills the ask's input, which is only present for a prompt.
 */
function answerDialog(accept = true, value?: string): void {
  const input = document.querySelector<HTMLInputElement>('[data-dialog-input]');
  if (input && value !== undefined) {
    input.value = value;
  }
  const selector = accept ? '[data-dialog-confirm]' : '[data-dialog-cancel]';
  document.querySelector<HTMLElement>(selector)!.click();
}

/**
 * Type into a field the way a person does.
 *
 * Setting `.value` alone is invisible to a listener that only answers `input`, so
 * this sets the value and dispatches a **bubbling** event — the same one typing
 * raises, which the row and the form both wait on for their derived state.
 */
function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Answer an ask the action only reaches after a microtask hop (one that follows an
 * awaited step, such as Extract asking for the target before the Draft name).
 *
 * The dialog is appended synchronously once reached, so a `setTimeout(0)` — which
 * runs after the pending microtasks flush — is enough to find it.
 */
async function answerDialogAfterHop(accept = true, value?: string): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  answerDialog(accept, value);
}

/**
 * Open one of the rail's create forms from its section `+`.
 *
 * The rail lists what exists; the Import and New Character forms are revealed on
 * demand so the index is never interrupted by empty inputs.
 */
function openRailForm(
  wb: ReturnType<typeof mountWorkbench>,
  form: 'import' | 'character',
): HTMLElement {
  const selector = form === 'import' ? '[data-rail-import-add]' : '[data-rail-character-add]';
  wb.root.querySelector<HTMLElement>(selector)!.click();
  return wb.root.querySelector('[data-region="rail"]')!;
}

/**
 * Open a Character in the rail so the Drafts and Assets it owns are rendered.
 *
 * They are nested under it and only shown while it is open, so a test that reads
 * one has to open the owner first.
 */
async function openCharacter(
  wb: ReturnType<typeof mountWorkbench>,
  characterId: string,
): Promise<void> {
  wb.root.querySelector<HTMLElement>(`[data-character="${characterId}"]`)!.click();
  await wb.settled();
}

/**
 * Open a Draft **for editing**.
 *
 * A Draft lands on Placement (it must be placed before it is painted), so a test
 * that paints or reads frames switches to the Clip face after loading.
 */
async function openDraftForEdit(
  wb: ReturnType<typeof mountWorkbench>,
  characterId: string,
  draftId: string,
): Promise<void> {
  await wb.loadDraft(characterId, draftId);
  wb.setMode('clip');
}

/**
 * Select a Segment from the strip's band.
 *
 * Bands are the cut list's own copy, so this works whether or not the rail has the
 * Recording's branch open. Segments are edited against a selection, so the buttons
 * only exist once one is picked.
 */
async function selectSegment(
  wb: ReturnType<typeof mountWorkbench>,
  cutId: string,
): Promise<void> {
  wb.root.querySelector<HTMLElement>(`[data-region="filmstrip"] [data-cut="${cutId}"]`)!.click();
  await wb.settled();
}

/**
 * Give every element a real track-sized rect.
 *
 * The strip is rebuilt when a gesture starts, so a rect stubbed on one node
 * would be lost mid-drag; stubbing the prototype survives the rebuild.
 */
function measureTrack(width = 80): void {
  const rect = { left: 0, top: 0, width, height: 24, right: width, bottom: 24, x: 0, y: 0 };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
}

const pointer = (type: string, x: number): PointerEvent =>
  new PointerEvent(type, { clientX: x, clientY: 0, button: 0, bubbles: true });

/**
 * Drag the track into a new range at the playhead and save it under `id`.
 *
 * Saving asks twice — a name, then the Character the cut belongs to — so both
 * dialogs are answered here; the Character answer is the preselected one.
 */
async function saveSegmentAtPlayhead(
  wb: ReturnType<typeof mountWorkbench>,
  id: string,
): Promise<void> {
  const width = 80;
  measureTrack(width);
  const frames = wb.root.querySelectorAll('[data-region="filmstrip"] [data-frame]').length;
  // The band is a drag, so a one-frame cut is a drag that never leaves its frame.
  const x = ((wb.activeFrame + 0.5) / frames) * width;
  const track = wb.root.querySelector<HTMLElement>('[data-region="filmstrip"] [data-pick]')!;
  track.dispatchEvent(pointer('pointerdown', x));
  window.dispatchEvent(pointer('pointerup', x));
  wb.root.querySelector<HTMLElement>('[data-pick-save]')!.click();
  answerDialog(true, id);
  // The second ask is raised after the first answer resolves, so it is not in the
  // DOM yet on the line above.
  await new Promise((resolve) => setTimeout(resolve, 0));
  answerDialog(true);
  await wb.settled();
}

describe('the workbench shell', () => {
  it('renders the four persistent regions', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    expect(wb.root.querySelector('[data-region="rail"]')).not.toBeNull();
    expect(wb.root.querySelector('[data-region="stage"]')).not.toBeNull();
    expect(wb.root.querySelector('[data-region="inspector"]')).not.toBeNull();
    expect(wb.root.querySelector('[data-region="filmstrip"]')).not.toBeNull();
  });

  it('lists Characters above Recordings: work starts at a Character', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    // A Recording is source material fed into a Character, so it comes second.
    expect(
      [...wb.root.querySelectorAll('[data-region="rail"] [data-library-section]')].map(
        (el) => (el as HTMLElement).dataset.librarySection,
      ),
    ).toEqual(['characters', 'recordings', 'exports']);
  });

  it('offers only the faces the open target has, and swaps the stage between them', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    const rail = wb.root.querySelector('[data-region="rail"]');
    const inspector = wb.root.querySelector('[data-region="inspector"]');
    const filmstrip = wb.root.querySelector('[data-region="filmstrip"]');
    const stage = wb.root.querySelector('[data-region="stage"]');
    const header = wb.root.querySelector('[data-region="context-bar"]');
    const targetBar = wb.root.querySelector('[data-region="target-bar"]');
    // The global faces live in the header, the target's own ones in the bar
    // above the stage; the two are read apart from here on.
    const globalModes = (): string[] =>
      [...header!.querySelectorAll('[data-mode]')].map((el) => (el as HTMLElement).dataset.mode!);
    const targetModes = (): string[] =>
      [...targetBar!.querySelectorAll('[data-mode]')].map((el) => (el as HTMLElement).dataset.mode!);

    // Nothing open: the target bar says where you are and has nothing to switch.
    expect(wb.mode).toBe('clip');
    expect(stage!.querySelector('[data-stage-view="clip-editor"]')).not.toBeNull();
    expect((inspector as HTMLElement).dataset.inspectorFor).toBe('clip');
    expect(targetModes()).toEqual(['clip']);
    // With no Character there is no subject to compose or export.
    expect(globalModes()).toEqual(['compose', 'export']);
    expect(
      [...header!.querySelectorAll<HTMLButtonElement>('[data-mode]')].every((b) => b.disabled),
    ).toBe(true);

    // A lone face is type, not a button: nothing to press because nothing to switch.
    const lone = targetBar!.querySelector('[data-mode]')!;
    expect(lone.tagName).toBe('SPAN');
    expect(lone.textContent).toBe('Clip');

    // A Draft is placed first, then painted; no filmstrip to scrub. Its faces stay
    // on the target bar and the header does not change.
    await wb.loadDraft('hero', 'wip');
    expect(wb.mode).toBe('align');
    expect((filmstrip as HTMLElement).hidden).toBe(true);
    expect(targetModes()).toEqual(['align', 'clip']);
    // The faces are short, single words: a set of views, not sentences.
    expect(
      [...targetBar!.querySelectorAll('[data-mode]')].map((el) => el.textContent),
    ).toEqual(['Align', 'Clip']);
    expect(globalModes()).toEqual(['compose', 'export']);
    expect(
      [...header!.querySelectorAll<HTMLButtonElement>('[data-mode]')].some((b) => b.disabled),
    ).toBe(false);

    // The faces are outside the stage, so a face switch cannot rebuild it.
    expect(stage!.querySelector('[data-mode]')).toBeNull();

    // Opening the Draft does mark it in the rail; that snapshot is what must survive.
    const railHtml = rail!.innerHTML;
    const headerHtml = header!.innerHTML;
    wb.root.querySelector<HTMLElement>('[data-mode="clip"]')!.click();
    await wb.settled();

    // The stage is the region whose committed view swaps.
    expect(wb.mode).toBe('clip');
    expect(stage!.querySelector('[data-stage-view="clip-editor"]')).not.toBeNull();
    expect(stage!.querySelector('[data-stage-view="alignment"]')).toBeNull();

    // Every region persists as a node; the header and the rail are never touched.
    expect(wb.root.querySelector('[data-region="rail"]')).toBe(rail);
    expect(wb.root.querySelector('[data-region="inspector"]')).toBe(inspector);
    expect(wb.root.querySelector('[data-region="filmstrip"]')).toBe(filmstrip);
    expect(wb.root.querySelector('[data-region="context-bar"]')).toBe(header);
    expect(rail!.innerHTML).toBe(railHtml);
    expect(header!.innerHTML).toBe(headerHtml);
    // The breadcrumb is unchanged too: the face changed, not the thing.
    expect(wb.root.querySelector('[data-region="context"]')!.textContent).toContain('hero/wip');

    // The inspector region persists, but its content is contextual to the face.
    expect((inspector as HTMLElement).dataset.inspectorFor).toBe('clip');
  });

  it('jumps to the Character when Composition is taken from another target', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    // The global faces are the header's, not the Draft's own.
    wb.root.querySelector<HTMLElement>('[data-region="context-bar"] [data-mode="compose"]')!.click();
    await wb.settled();

    expect(wb.mode).toBe('compose');
    expect(wb.activeDraft).toBeNull();
    expect(wb.root.querySelector('[data-stage-view="compose"]')).not.toBeNull();
    // The target bar followed the jump to the Character it composed.
    expect(wb.root.querySelector('[data-region="context"]')!.textContent).toContain('hero');
  });

  it('clamps to a face the target has when asked for one it does not', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    await wb.loadRecording('idle');
    expect(wb.mode).toBe('cut');

    // A Recording has no Alignment face, so the request falls back to Cutting.
    wb.setMode('align');
    expect(wb.mode).toBe('cut');
  });
});

describe('the Library', () => {
  it('lists Recordings, and a Character with what it owns', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    const rail = wb.root.querySelector('[data-region="rail"]')!;
    const recordings = [...rail.querySelectorAll('[data-recording]')].map(
      (el) => (el as HTMLElement).dataset.recording,
    );

    expect(recordings).toEqual(['idle', 'fat-walk']);
    // Nothing of the Character's is listed until it is opened: only the open
    // branch is expanded, which is what keeps the rail one screen tall.
    expect(rail.querySelector('[data-asset]')).toBeNull();
    expect(rail.querySelector('[data-character="hero"]')).not.toBeNull();

    await openCharacter(wb, 'hero');
    const assets = [...rail.querySelectorAll('[data-asset]')].map((el) => ({
      id: (el as HTMLElement).dataset.asset,
      kind: (el as HTMLElement).dataset.assetKind,
    }));
    expect(assets).toEqual([
      { id: 'walk', kind: 'clip' },
      { id: 'greeting', kind: 'sequence' },
    ]);
  });

  it('collapses a Character again when another one is opened', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    await openCharacter(wb, 'hero');
    const rail = wb.root.querySelector('[data-region="rail"]')!;
    expect(rail.querySelector('[data-asset]')).not.toBeNull();

    // Opening a Draft keeps that Character open — it is the Draft's owner.
    rail.querySelector<HTMLElement>('[data-draft="wip"]')!.click();
    await wb.settled();
    expect(rail.querySelector('[data-asset]')).not.toBeNull();
  });

  it('makes a Recording the active item when it is clicked', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    wb.root.querySelector<HTMLElement>('[data-recording="fat-walk"]')!.click();
    await wb.settled();

    expect(wb.activeRecording).toBe('fat-walk');
  });

  it('reveals a Recording’s Segments only while it is the open one', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    const rail = wb.root.querySelector<HTMLElement>('[data-region="rail"]')!;

    // Collapsed by default: the cut list is a branch, not standing furniture.
    expect(rail.querySelector('[data-segment]')).toBeNull();

    rail.querySelector<HTMLElement>('[data-recording="idle"]')!.click();
    await wb.settled();
    expect(rail.querySelectorAll('[data-segment]').length).toBeGreaterThan(0);

    // A rail Segment row selects it: the row is a pick, not another load.
    rail.querySelector<HTMLElement>('[data-segment="walk"]')!.click();
    await wb.settled();
    expect(wb.root.querySelector('[data-segment-delete="walk"]')).not.toBeNull();

    // Opening a Character leaves the Recording, so its branch folds away with it.
    // A Segment is in hand, so the click also extracts and asks for a Draft name.
    rail.querySelector<HTMLElement>('[data-character="hero"]')!.click();
    await answerDialogAfterHop();
    await wb.settled();
    expect(rail.querySelector('[data-recording="idle"]')!.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(rail.querySelector('[data-segment]')).toBeNull();
  });

  it('keeps one branch open: a Recording closes the Character above it', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    const rail = wb.root.querySelector<HTMLElement>('[data-region="rail"]')!;

    await openCharacter(wb, 'hero');
    expect(rail.querySelector('[data-asset]')).not.toBeNull();

    rail.querySelector<HTMLElement>('[data-recording="idle"]')!.click();
    await wb.settled();

    expect(rail.querySelector('[data-character="hero"]')!.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(rail.querySelector('[data-asset]')).toBeNull();

    // The same row folds its own branch away again.
    rail.querySelector<HTMLElement>('[data-recording="idle"]')!.click();
    await wb.settled();
    expect(rail.querySelector('[data-segment]')).toBeNull();
    // ...without leaving the Recording: the branch is disclosure, not navigation.
    expect(wb.activeRecording).toBe('idle');
  });

  it('extracts the selected Segment into a Character clicked in the Library', async () => {
    const extracted: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        extractClipDraft: async (characterId, request) => {
          extracted.push({ characterId, ...request });
          return DRAFT;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');
    const rail = wb.root.querySelector<HTMLElement>('[data-region="rail"]')!;

    rail.querySelector<HTMLElement>('[data-recording="idle"]')!.click();
    await wb.settled();
    rail.querySelector<HTMLElement>('[data-segment="walk"]')!.click();
    await wb.settled();

    // The rail Character row answers the same question as the save dialog, so it
    // turns the cut in hand into that Character's Draft instead of only opening it.
    rail.querySelector<HTMLElement>('[data-character="hero"]')!.click();
    await answerDialogAfterHop();
    await wb.settled();

    expect(extracted).toEqual([
      { characterId: 'hero', recordingId: 'idle', cutId: 'walk', draftId: 'walk' },
    ]);
    expect(wb.mode).toBe('align');
    expect(wb.root.querySelector('[data-region="inspector"] [data-inspector-section="alignment"]')).not.toBeNull();
  });

  it('just opens the Character when no Segment is selected', async () => {
    const extracted: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        extractClipDraft: async (characterId, request) => {
          extracted.push({ characterId, ...request });
          return DRAFT;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');

    wb.root.querySelector<HTMLElement>('[data-character="hero"]')!.click();
    await wb.settled();

    expect(extracted).toEqual([]);
    expect(wb.mode).toBe('align');
  });
});

describe('the filmstrip', () => {
  it('scrubs frame-accurately: one cell per frame index', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadRecording('idle');

    const frames = wb.root.querySelectorAll('[data-region="filmstrip"] [data-frame]');
    expect(frames).toHaveLength(CUTS.frameCount);
    expect([...frames].map((el) => (el as HTMLElement).dataset.frame)).toEqual([
      '0', '1', '2', '3', '4', '5', '6', '7',
    ]);
  });

  it('keeps every cell a real width on a Recording too long to fit', async () => {
    const long: CutList = { ...CUTS, frameCount: 2000, cuts: [] };
    const wb = mountWorkbench(container, {
      api: fakeApi({ readCutList: async () => long }),
    });
    await wb.ready;
    // A real viewport, so the fit has a width to fall short of.
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(600);
    await wb.loadRecording('idle');

    const film = wb.root.querySelector<HTMLElement>('[data-region="filmstrip"] .film')!;
    expect(film.classList.contains('is-dense')).toBe(true);
    // The fit would be under a pixel a cell, so the axis takes a floor width and
    // scrolls instead of collapsing into a comb of zero-width columns.
    const content = wb.root.querySelector<HTMLElement>('[data-strip-content]')!;
    expect(Number.parseFloat(content.style.width)).toBeGreaterThan(600);
    expect(film.style.gap).toBe('0px');
    vi.restoreAllMocks();
  });

  it('moves the active frame by frame index when a cell is clicked', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadRecording('idle');

    expect(wb.activeFrame).toBe(0);
    wb.root.querySelector<HTMLElement>('[data-frame="3"]')!.click();

    expect(wb.activeFrame).toBe(3);
    const filmstrip = wb.root.querySelector('[data-region="filmstrip"]')!;
    expect(filmstrip.getAttribute('data-active-frame')).toBe('3');
    expect(
      filmstrip.querySelector('[data-frame="3"]')!.classList.contains('sel'),
    ).toBe(true);
  });

  it("renders the Recording timeline with its cut ranges from the cut list", async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadRecording('idle');

    const cuts = [...wb.root.querySelectorAll('[data-region="filmstrip"] [data-cut]')].map(
      (el) => {
        const node = el as HTMLElement;
        return {
          id: node.dataset.cut,
          start: node.dataset.cutStart,
          end: node.dataset.cutEnd,
        };
      },
    );
    expect(cuts).toEqual([
      { id: 'walk', start: '1', end: '4' },
      { id: 'turn', start: '5', end: '8' },
    ]);
    // Only the band being edited exposes edges, so a dense Recording is not a
    // field of grab points: press a band first, then its edges.
    expect(wb.root.querySelectorAll('[data-region="filmstrip"] [data-cut-handle]')).toHaveLength(0);
    wb.root.querySelector<HTMLElement>('[data-region="filmstrip"] [data-cut="walk"]')!.click();
    expect(wb.root.querySelectorAll('[data-region="filmstrip"] [data-cut-handle]')).toHaveLength(2);
  });

  it('marks a range on the same rail the cut bands live on', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadRecording('idle');
    measureTrack();
    const track = wb.root.querySelector<HTMLElement>('[data-region="filmstrip"] [data-pick]')!;

    track.dispatchEvent(pointer('pointerdown', 10));
    window.dispatchEvent(pointer('pointermove', 30));
    window.dispatchEvent(pointer('pointerup', 30));

    expect(wb.root.querySelector('[data-region="filmstrip"] [data-pick-save]')).not.toBeNull();
    expect(wb.activeFrame).toBe(1);
  });

  it('shows the marked range as indices and takes them typed', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadRecording('idle');
    measureTrack();
    const track = wb.root.querySelector<HTMLElement>('[data-region="filmstrip"] [data-pick]')!;

    track.dispatchEvent(pointer('pointerdown', 10));
    window.dispatchEvent(pointer('pointermove', 30));
    window.dispatchEvent(pointer('pointerup', 30));

    const strip = (): HTMLElement => wb.root.querySelector('[data-region="filmstrip"]')!;
    expect(strip().querySelector('[data-pick-band-start]')!.textContent).toBe('1');
    expect(strip().querySelector('[data-pick-band-end]')!.textContent).toBe('3');

    const start = strip().querySelector<HTMLInputElement>('[data-pick-start]')!;
    const end = strip().querySelector<HTMLInputElement>('[data-pick-end]')!;
    expect(start.value).toBe('1');
    expect(end.value).toBe('3');

    // Typing an end is a direct edit of the range, and it takes the playhead to
    // the start so the preview matches.
    end.value = '5';
    end.dispatchEvent(new Event('change'));
    expect(strip().querySelector('[data-pick-band]')!.getAttribute('title')).toBe('frames 1–5');

    start.value = '2';
    start.dispatchEvent(new Event('change'));
    expect(strip().querySelector('[data-pick-band]')!.getAttribute('title')).toBe('frames 2–5');
    expect(wb.activeFrame).toBe(2);
  });

  it('keeps the strip where it was scrolled when a Segment is selected', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadRecording('idle');
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(800);
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(80);
    const scroller = (): HTMLElement =>
      wb.root.querySelector('[data-region="filmstrip"] [data-strip-scroll]')!;

    scroller().scrollLeft = 120;
    await selectSegment(wb, 'walk');

    expect(scroller().scrollLeft).toBe(120);
    vi.restoreAllMocks();
  });

  it('keeps marking and editing exclusive, so Play has one target', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadRecording('idle');
    const track = wb.root.querySelector<HTMLElement>('[data-region="filmstrip"] [data-pick]')!;
    measureTrack();
    const strip = (): HTMLElement => wb.root.querySelector('[data-region="filmstrip"]')!;

    // Marking drops the edited Segment...
    wb.root.querySelector<HTMLElement>('[data-cut="walk"]')!.click();
    expect(strip().querySelectorAll('[data-cut-handle]')).toHaveLength(2);
    wb.root.querySelector<HTMLElement>('[data-pick]')!.dispatchEvent(pointer('pointerdown', 10));
    window.dispatchEvent(pointer('pointerup', 10));
    expect(strip().querySelectorAll('[data-cut-handle]')).toHaveLength(0);

    // ...and pressing a band drops the mark.
    expect(wb.root.querySelector('[data-region="filmstrip"] [data-pick-save]')).not.toBeNull();
    strip().querySelector<HTMLElement>('[data-cut="turn"]')!.click();
    expect(wb.root.querySelector('[data-region="filmstrip"] [data-pick-save]')).toBeNull();
  });

  it('saves a re-cut on release and puts it back on Escape', async () => {    const written: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        setSegmentRange: async (recordingId, cutId, startFrame, endFrame) => {
          written.push({ recordingId, cutId, startFrame, endFrame });
          return CUTS;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');
    measureTrack();

    wb.root.querySelector<HTMLElement>('[data-cut="walk"]')!.click();
    await wb.settled();
    const handle = (): HTMLElement =>
      wb.root.querySelector<HTMLElement>('[data-cut="walk"] [data-cut-handle="end"]')!;

    // Releasing is the save: a trim is a direct edit of a stored range.
    handle().dispatchEvent(pointer('pointerdown', 60));
    window.dispatchEvent(pointer('pointermove', 50));
    window.dispatchEvent(pointer('pointerup', 50));
    await wb.settled();
    expect(written).toEqual([{ recordingId: 'idle', cutId: 'walk', startFrame: 1, endFrame: 5 }]);

    // Escape abandons a drag instead of writing it.
    written.length = 0;
    handle().dispatchEvent(pointer('pointerdown', 60));
    window.dispatchEvent(pointer('pointermove', 70));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(pointer('pointerup', 70));
    await wb.settled();
    expect(written).toEqual([]);
  });
});

describe('the box on a Segment', () => {
  /** A 80x24 frame at the origin, so a pointer maps 1:1 to a source pixel. */
  const pointerAt = (type: string, x: number, y: number): PointerEvent =>
    new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });

  it('boxes a region by dragging on the frame, and escapes to nothing', async () => {
    const written: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        setSegmentRect: async (recordingId, cutId, rect) => {
          written.push({ recordingId, cutId, rect });
          return CUTS;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');
    measureTrack(80);

    await selectSegment(wb, 'walk');
    const holder = (): HTMLElement =>
      wb.root.querySelector<HTMLElement>('[data-draw-box]')!;
    expect(holder()).not.toBeNull();

    // A drag is a box: the pointer's frame pixels, inclusive of both corners.
    holder().dispatchEvent(pointerAt('pointerdown', 10, 4));
    window.dispatchEvent(pointerAt('pointermove', 30, 12));
    window.dispatchEvent(pointerAt('pointerup', 30, 12));
    await wb.settled();
    expect(written).toEqual([
      { recordingId: 'idle', cutId: 'walk', rect: { x: 10, y: 4, width: 21, height: 9 } },
    ]);

    // Escape abandons a drag instead of writing it.
    written.length = 0;
    holder().dispatchEvent(pointerAt('pointerdown', 2, 2));
    window.dispatchEvent(pointerAt('pointermove', 20, 20));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wb.settled();
    expect(written).toEqual([]);
  });

  it('shows the box and can drop it, or fill it from the content', async () => {
    const written: unknown[] = [];
    const boxed: CutList = {
      ...CUTS,
      cuts: [{ id: 'walk', startFrame: 1, endFrame: 4, rect: { x: 1, y: 2, width: 3, height: 4 } }],
    };
    const wb = mountWorkbench(container, {
      api: fakeApi({
        readCutList: async () => boxed,
        setSegmentRect: async (recordingId, cutId, rect) => {
          written.push({ recordingId, cutId, rect });
          return boxed;
        },
        segmentContentBounds: async () => ({ x: 2, y: 3, width: 1, height: 1 }),
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');
    measureTrack(80);

    await selectSegment(wb, 'walk');
    const box = wb.root.querySelector<HTMLElement>('[data-cut-box]');
    expect(box?.dataset.box).toBe('1,2,3,4');
    // The box is positioned in percentages, so its containing block must be the
    // frame itself — not the holder that centres and letterboxes it.
    const plate = box?.parentElement;
    expect(plate?.className).toBe('cut-image');
    expect(plate?.parentElement?.dataset.drawBox).toBe('');
    expect(plate?.querySelector('img')).not.toBeNull();
    expect(wb.root.querySelector('[data-segment-box]')?.textContent).toContain('box 1,2 3×4');

    wb.root.querySelector<HTMLElement>('[data-segment-box-clear]')!.click();
    await wb.settled();
    expect(written).toEqual([{ recordingId: 'idle', cutId: 'walk', rect: null }]);

    written.length = 0;
    wb.root.querySelector<HTMLElement>('[data-segment-box-fit]')!.click();
    await wb.settled();
    expect(written).toEqual([
      { recordingId: 'idle', cutId: 'walk', rect: { x: 2, y: 3, width: 1, height: 1 } },
    ]);
  });
});

describe('playing a Recording back', () => {
  /** Playback is timer-driven, so these run on fake timers from a loaded Recording. */
  async function playing(): Promise<ReturnType<typeof mountWorkbench>> {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadRecording('idle');
    return wb;
  }

  const play = (wb: ReturnType<typeof mountWorkbench>): void => {
    wb.root.querySelector<HTMLElement>('[data-region="filmstrip"] [data-recording-play]')!.click();
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // A pending playback tick would otherwise survive the timer swap and keep
    // rescheduling itself on real timers, so the process never exits.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('advances from the selected frame at the Recording’s own delays', async () => {
    const wb = await playing();

    wb.root.querySelector<HTMLElement>('[data-frame="2"]')!.click();
    play(wb);
    expect(wb.activeFrame).toBe(2);

    vi.advanceTimersByTime(60);
    expect(wb.activeFrame).toBe(3);

    // The big preview and the strip follow the frame without a re-render.
    const image = wb.root.querySelector<HTMLImageElement>('[data-recording-frame]')!;
    expect(image.getAttribute('src')).toBe('/api/recordings/idle/frames/3');
    expect(wb.root.querySelector('[data-region="filmstrip"]')!.getAttribute('data-active-frame'))
      .toBe('3');
  });

  it("stops at the Segment's last frame and resets the toggle", async () => {
    const wb = await playing();
    play(wb);

    vi.advanceTimersByTime(50 * (CUTS.frameCount + 2));

    // "walk" is [1, 4), so the run ends on frame 3 and never enters "turn".
    expect(wb.activeFrame).toBe(3);
    const button = wb.root.querySelector<HTMLElement>('[data-recording-play]')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.textContent).toBe('▶ Play');
  });

  it('toggles to Pause, and pausing leaves the frame where it is', async () => {
    const wb = await playing();
    play(wb);

    const button = wb.root.querySelector<HTMLElement>('[data-recording-play]')!;
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toBe('⏸ Pause');

    vi.advanceTimersByTime(50);
    const paused = wb.activeFrame;
    button.click();
    vi.advanceTimersByTime(500);

    expect(wb.activeFrame).toBe(paused);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('plays only the Segment the playhead is in, stopping at its end', async () => {
    const wb = await playing();
    // "walk" covers [1, 4): playing from inside it runs to 3 and no further.
    wb.root.querySelector<HTMLElement>('[data-frame="2"]')!.click();
    play(wb);

    expect(wb.activeFrame).toBe(2);
    vi.advanceTimersByTime(50 * 20);

    expect(wb.activeFrame).toBe(3);
    expect(wb.root.querySelector<HTMLElement>('[data-recording-play]')!.getAttribute(
      'aria-pressed',
    )).toBe('false');
  });

  it('replays a Segment from its start when played at its last frame', async () => {
    const wb = await playing();
    // Frame 7 is the last frame of "turn" [5, 8).
    wb.root.querySelector<HTMLElement>('[data-frame="7"]')!.click();

    play(wb);

    expect(wb.activeFrame).toBe(5);
  });

  it('plays the Segment after the playhead when it sits before the first cut', async () => {
    const wb = await playing();
    // Frame 0 is before the first cut, so the playhead resolves to "walk" [1, 4).
    expect(wb.activeFrame).toBe(0);
    play(wb);

    expect(wb.activeFrame).toBe(1);
    vi.advanceTimersByTime(50 * 20);

    expect(wb.activeFrame).toBe(3);
  });

  it('plays the whole Recording only when it has no Segment at all', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({ readCutList: async () => ({ ...CUTS, cuts: [] }) }),
    });
    await wb.ready;
    await wb.loadRecording('idle');

    play(wb);
    vi.advanceTimersByTime(50 * 20);

    expect(wb.activeFrame).toBe(CUTS.frameCount - 1);
  });

  it('takes over from playback when a frame is picked by hand', async () => {
    const wb = await playing();
    play(wb);
    vi.advanceTimersByTime(50);

    wb.root.querySelector<HTMLElement>('[data-frame="6"]')!.click();
    vi.advanceTimersByTime(500);

    expect(wb.activeFrame).toBe(6);
  });
});

describe('the Clip editor stage', () => {
  it('lists Drafts in the Library and makes one active on click', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openCharacter(wb, 'hero');

    const draftItems = wb.root.querySelectorAll('[data-region="rail"] [data-draft]');
    expect([...draftItems].map((el) => (el as HTMLElement).dataset.draft)).toEqual(['wip']);

    wb.root.querySelector<HTMLElement>('[data-draft="wip"]')!.click();
    await wb.settled();

    expect(wb.activeDraft).toEqual({ characterId: 'hero', draftId: 'wip' });
  });

  it("renders a Draft's frames frame-by-frame when it is active", async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    const view = wb.root.querySelector('[data-stage-view="clip-editor"]')!;
    const img = view.querySelector<HTMLImageElement>('[data-draft-frame]')!;
    expect(img.getAttribute('src')).toBe('/api/characters/hero/drafts/wip/frames/0');
    expect(view.querySelector('[data-draft-frame-counter]')!.textContent).toBe('frame 0 / 3');
    expect(view.querySelectorAll('[data-draft-frame-cell]')).toHaveLength(3);
    expect(wb.activeDraftFrame).toBe(0);
  });

  it('shows a mirrored Draft turned on the Clip face, and says so', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({ readClipDraft: async () => ({ ...DRAFT, flipX: true }) }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    // The stored frame stays unflipped (Repair is authored on it); only the view
    // turns, sheet and overlay together.
    const sheet = wb.root.querySelector<HTMLElement>('[data-draft-sheet]')!;
    expect(sheet.classList.contains('is-mirrored')).toBe(true);
    expect(
      [...wb.root.querySelectorAll('[data-region="inspector"] dt')].find(
        (cell) => cell.textContent === 'mirror',
      )?.nextElementSibling?.textContent,
    ).toBe('on');
  });

  it('leaves an unmirrored Draft upright', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    expect(
      wb.root.querySelector('[data-draft-sheet]')!.classList.contains('is-mirrored'),
    ).toBe(false);
  });

  it('paints through the mirror onto the stored, unflipped pixel', async () => {
    const written: Array<{ x: number; y: number }> = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        readClipDraft: async () => ({ ...DRAFT, flipX: true }),
        appendRepairOperation: async (_characterId, _draftId, operation) => {
          written.push(operation.geometry as { x: number; y: number });
          return EMPTY_REPAIR;
        },
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    const img = wb.root.querySelector<HTMLImageElement>('[data-draft-frame]')!;
    Object.defineProperty(img, 'naturalWidth', { value: 10, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 10, configurable: true });
    measureTrack(10);

    // A click 1px in from the left of a turned 10px frame is its pixel 8.
    wb.root.querySelector<HTMLElement>('[data-repair-tool="paint"]')!.click();
    img.dispatchEvent(pointer('pointerdown', 1));
    window.dispatchEvent(pointer('pointerup', 1));
    await wb.settled();

    expect(written[0]).toMatchObject({ points: [[8, 0]] });
  });

  it('navigates Draft frames by frame index (the unit)', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    wb.root.querySelector<HTMLElement>('[data-frame-step="next"]')!.click();
    expect(wb.activeDraftFrame).toBe(1);
    expect(
      wb.root.querySelector('[data-draft-frame]')!.getAttribute('src'),
    ).toBe('/api/characters/hero/drafts/wip/frames/1');
    expect(
      wb.root.querySelector('[data-draft-frame-counter]')!.textContent,
    ).toBe('frame 1 / 3');

    wb.root.querySelector<HTMLElement>('[data-draft-frame-cell="2"]')!.click();
    expect(wb.activeDraftFrame).toBe(2);
    expect(
      wb.root.querySelector('[data-draft-frame]')!.getAttribute('src'),
    ).toBe('/api/characters/hero/drafts/wip/frames/2');
  });

  it('zooms the frame by whole steps, from a fitted 1× up to the ceiling', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    // The label is replaced with the stage on every render, so always re-read it.
    const label = (): HTMLElement => wb.root.querySelector<HTMLElement>('[data-draft-zoom-label]')!;
    // A fitted view is the default and says so; it is not a zoom level of its own.
    expect(label().textContent).toBe('1×');
    expect(label().classList.contains('is-fitted')).toBe(true);

    const zoomIn = wb.root.querySelector<HTMLElement>('[data-draft-zoom-step="1"]')!;
    zoomIn.click();
    expect(label().textContent).toBe('2×');
    expect(label().classList.contains('is-fitted')).toBe(false);

    // Repair needs whole image pixels, so the scale never becomes fractional and
    // never runs away past the ceiling.
    for (let i = 0; i < 10; i += 1) {
      wb.root.querySelector<HTMLElement>('[data-draft-zoom-step="1"]')!.click();
    }
    expect(label().textContent).toBe('32×');
    expect(wb.draftZoom).toBe(32);
  });

  it('hands the scale back to the fit, and never goes below 1×', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    const label = (): HTMLElement => wb.root.querySelector<HTMLElement>('[data-draft-zoom-label]')!;
    wb.root.querySelector<HTMLElement>('[data-draft-zoom-step="-1"]')!.click();
    expect(label().textContent).toBe('1×');
    expect(wb.draftZoom).toBe(1);

    wb.root.querySelector<HTMLElement>('[data-draft-zoom-step="1"]')!.click();
    expect(label().textContent).toBe('2×');
    wb.root.querySelector<HTMLElement>('[data-draft-zoom-fit]')!.click();
    expect(label().textContent).toBe('1×');
    expect(label().classList.contains('is-fitted')).toBe(true);
    // Fitting is the absence of a choice, not a zoom of 1.
    expect(wb.draftZoom).toBeNull();
  });

  it('fits a small frame up to a whole-number rate that fills the stage', () => {
    // jsdom never lays anything out, so the stage's room is stated by hand: the fit
    // is the only thing that reads it.
    const stage = document.createElement('div');
    Object.defineProperty(stage, 'clientWidth', { value: 750 });
    Object.defineProperty(stage, 'clientHeight', { value: 630 });
    const board = document.createElement('div');
    const img = document.createElement('img');
    Object.defineProperty(img, 'naturalWidth', { value: 32 });
    Object.defineProperty(img, 'naturalHeight', { value: 32 });

    const ctx = {
      state: { draftZoom: null },
      regions: { stage },
    } as unknown as Parameters<typeof draftScale>[0];
    // 630 − 150 is the tighter side: (480 / 32) is 15, and the rate stays whole.
    expect(draftScale(ctx, board, img)).toBe(15);
  });

  it('zooms on Ctrl + wheel only, so plain wheel still scrolls', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    const board = wb.root.querySelector<HTMLElement>('[data-draft-board]')!;
    const label = (): HTMLElement => wb.root.querySelector<HTMLElement>('[data-draft-zoom-label]')!;
    const wheel = (ctrlKey: boolean, deltaY: number): WheelEvent => {
      const event = new WheelEvent('wheel', { ctrlKey, deltaY, clientX: 0, clientY: 0, cancelable: true });
      board.dispatchEvent(event);
      return event;
    };

    expect(wheel(false, -100).defaultPrevented).toBe(false);
    expect(label().textContent).toBe('1×');

    expect(wheel(true, -100).defaultPrevented).toBe(true);
    expect(label().textContent).toBe('2×');
    expect(wb.draftZoom).toBe(2);
  });

  it('gives the brush a footprint overlay the size of the frame', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    const overlay = wb.root.querySelector<HTMLCanvasElement>('[data-draft-overlay]')!;
    expect(overlay).not.toBeNull();
    // Over the frame but out of the way of the painting pointer.
    expect(overlay.parentElement!.hasAttribute('data-draft-sheet')).toBe(true);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    // The pixel readout starts empty rather than showing a stale position.
    expect(wb.root.querySelector('[data-draft-cursor]')!.textContent).toBe('—');
  });

  it('clamps the brush size to the pixels the server will stamp', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    const size = wb.root.querySelector<HTMLInputElement>('[data-repair-size]')!;
    const set = (value: string): void => {
      size.value = value;
      size.dispatchEvent(new Event('input', { bubbles: true }));
    };

    // Typing is free, but the size handed to the server is always stampable.
    set('0');
    expect(wb.brushSize).toBe(1);
    set('999');
    expect(wb.brushSize).toBe(64);
    set('');
    expect(wb.brushSize).toBe(1);
    set('3');
    expect(wb.brushSize).toBe(3);
  });

  it('renders the contextual Clip-editor inspector with per-frame info and a Repair slot', async () => {    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    const inspector = wb.root.querySelector('[data-region="inspector"]') as HTMLElement;
    expect(inspector.dataset.inspectorFor).toBe('clip');
    const draftSection = inspector.querySelector('[data-inspector-section="draft"]');
    expect(draftSection).not.toBeNull();
    // Per-frame facts, not just the Draft as a whole.
    const keys = [...draftSection!.querySelectorAll('dt')].map((el) => el.textContent);
    expect(keys).toEqual(
      expect.arrayContaining(['character', 'draft', 'recording', 'frames', 'frame', 'delay']),
    );
    // The log stays in the inspector; the tools themselves moved to the stage.
    expect(
      inspector.querySelector('[data-inspector-section="repair"] [data-repair-log]'),
    ).not.toBeNull();
    expect(wb.root.querySelector('[data-region="stage"] [data-repair-bar]')).not.toBeNull();
  });

  it('keeps the active Draft when the mode changes, swapping only the stage', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    const rail = wb.root.querySelector('[data-region="rail"]')!;
    const filmstrip = wb.root.querySelector('[data-region="filmstrip"]')!;
    const railHtml = rail.innerHTML;
    const filmstripHtml = filmstrip.innerHTML;

    wb.root.querySelector<HTMLElement>('[data-mode="align"]')!.click();
    expect(wb.activeDraft).toEqual({ characterId: 'hero', draftId: 'wip' });
    expect(rail.innerHTML).toBe(railHtml);
    expect(filmstrip.innerHTML).toBe(filmstripHtml);

    wb.root.querySelector<HTMLElement>('[data-mode="clip"]')!.click();
    const img = wb.root.querySelector<HTMLImageElement>('[data-draft-frame]')!;
    expect(img.getAttribute('src')).toBe('/api/characters/hero/drafts/wip/frames/0');
  });
});

describe('the Clip editor Repair controls', () => {
  it('renders the brush, eyedropper, scope, undo under the frame and the log beside it', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    const controls = wb.root.querySelector('[data-region="stage"] [data-repair-bar]')!;
    expect(controls).not.toBeNull();
    expect(controls.querySelector('[data-repair-tool="paint"]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-tool="erase"]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-tool="rect"]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-tool="eyedropper"]')).not.toBeNull();
    // The tools are glyphs: the button carries no text, only an accessible name.
    const brush = controls.querySelector<HTMLElement>('[data-repair-tool="paint"]')!;
    expect(brush.querySelector('svg')).not.toBeNull();
    expect(brush.textContent).toBe('');
    expect(brush.getAttribute('aria-label')).toBe('Brush');
    expect(brush.getAttribute('aria-pressed')).toBe('true');
    expect(controls.querySelector('[data-repair-color]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-size]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-scope]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-undo]')).not.toBeNull();
    // The operations are read, not reached for: they stay in the inspector.
    expect(
      wb.root.querySelector('[data-inspector-section="repair"] [data-repair-ops]'),
    ).not.toBeNull();
  });

  it('reflects a Draft’s existing Repair in the operation list', async () => {
    const repaired: RepairState = {
      operations: [
        {
          tool: 'erase-rect',
          frames: { start: 0, end: 1 },
          geometry: { x: 1, y: 4, width: 1, height: 1 },
        },
      ],
      warnings: [],
    };
    const wb = mountWorkbench(container, { api: fakeApi({ readRepair: async () => repaired }) });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    const ops = wb.root.querySelectorAll('[data-repair-op]');
    expect(ops).toHaveLength(1);
    expect((ops[0] as HTMLElement).dataset.repairTool).toBe('erase-rect');
    expect(wb.repair?.operations).toHaveLength(1);
  });

  it('surfaces a Repair-validity warning (never a silent misapplication)', async () => {
    const warned: RepairState = {
      operations: [],
      warnings: [{ code: 'framing-changed', message: 'the Canvas changed' }],
    };
    const wb = mountWorkbench(container, { api: fakeApi({ readRepair: async () => warned }) });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    expect(
      wb.root.querySelector('[data-repair-warning="framing-changed"]'),
    ).not.toBeNull();
  });
});

describe('the Alignment stage', () => {
  it('ghosts Clips on the shared Canvas against the Anchor', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    // A Character's one face is Alignment, so opening it is how you get here.
    await wb.loadCharacter('hero');

    const view = wb.root.querySelector('[data-stage-view="alignment"]')!;
    const canvas = view.querySelector('[data-alignment-canvas]') as HTMLElement;
    expect(canvas.dataset.canvasWidth).toBe('4');
    expect(canvas.dataset.canvasHeight).toBe('6');
    const anchor = view.querySelector('[data-anchor]') as HTMLElement;
    expect(anchor.dataset.anchorX).toBe('2');
    expect(anchor.dataset.anchorY).toBe('6');

    const ghosts = [...view.querySelectorAll('[data-align-ghost]')].map((el) => {
      const node = el as HTMLElement;
      return {
        kind: node.dataset.kind,
        id: node.dataset.asset ?? node.dataset.draft,
        ox: node.dataset.offsetX,
        oy: node.dataset.offsetY,
      };
    });
    expect(ghosts).toEqual([
      { kind: 'clip', id: 'walk', ox: '0', oy: '-1' },
      { kind: 'draft', id: 'wip', ox: '0', oy: '0' },
    ]);
    // Each ghost carries a Canvas-sized image (the Clip's baked sheet).
    expect(view.querySelectorAll('[data-align-ghost-image]')).toHaveLength(2);
  });

  it('shows per-Clip offsets and an explicit resize action with the content floor', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const inspector = wb.root.querySelector('[data-region="inspector"]') as HTMLElement;
    expect(inspector.dataset.inspectorFor).toBe('align');
    expect(inspector.querySelector('[data-inspector-section="alignment"]')).not.toBeNull();
    // Per-Clip offsets (the committed Clip is read-only; the Draft is editable).
    expect(inspector.querySelector('[data-align-clip-offset="walk"]')).not.toBeNull();
    expect(inspector.querySelector('[data-align-offset-x]')).not.toBeNull();
    expect(inspector.querySelector('[data-align-offset-y]')).not.toBeNull();
    // The size is editable in both directions, down to the content floor.
    expect(inspector.querySelector('[data-resize-canvas-action]')).not.toBeNull();
    expect(inspector.querySelector('[data-fit-canvas-action]')).not.toBeNull();
    expect(inspector.querySelector('[data-align-floor]')!.getAttribute('data-align-floor')).toBe(
      '4x6',
    );
    expect(
      inspector.querySelector<HTMLInputElement>('[data-resize-width]')!.min,
    ).toBe('4');
    expect(
      inspector.querySelector<HTMLInputElement>('[data-resize-height]')!.min,
    ).toBe('6');
  });

  it('resizes the Canvas from the inspector, shrunken or grown', async () => {
    const sized: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        resizeCanvas: async (characterId, width, height) => {
          sized.push({ characterId, width, height });
          return {
            canvas: { width, height, anchor: { x: width / 2, y: height } },
            rebakedClips: [],
            rebakedSequences: [],
            repairWarnings: [],
          };
        },
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const inspector = wb.root.querySelector('[data-region="inspector"]') as HTMLElement;
    const widthInput = inspector.querySelector('[data-resize-width]') as HTMLInputElement;
    const heightInput = inspector.querySelector('[data-resize-height]') as HTMLInputElement;
    widthInput.value = '6';
    widthInput.dispatchEvent(new Event('input'));
    heightInput.value = '8';
    heightInput.dispatchEvent(new Event('input'));
    inspector.querySelector<HTMLElement>('[data-resize-canvas-action]')!.click();
    await wb.settled();

    expect(sized).toEqual([{ characterId: 'hero', width: 6, height: 8 }]);
  });

  it('fits the Canvas to its content in one click', async () => {
    const fitted: string[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        // Room above the floor, so there is something to fit down to.
        readCharacterAlignment: async () => ({
          ...ALIGNMENT,
          canvas: { width: 8, height: 10, anchor: { x: 4, y: 10 } },
        }),
        fitCanvas: async (characterId) => {
          fitted.push(characterId);
          return {
            canvas: ALIGNMENT.canvas,
            rebakedClips: [],
            rebakedSequences: [],
            repairWarnings: [],
          };
        },
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    wb.root
      .querySelector<HTMLElement>('[data-fit-canvas-action]')!
      .click();
    await wb.settled();
    expect(fitted).toEqual(['hero']);
  });

  it('offers Fit to content only while there is room above the floor', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({
        // The Canvas is already the floor.
        readCharacterAlignment: async () => ALIGNMENT,
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const fit = wb.root.querySelector<HTMLButtonElement>('[data-fit-canvas-action]')!;
    expect(fit.disabled).toBe(true);
    expect(fit.title).toMatch(/smallest size/i);
  });

  it('holds the rate through a resize, so only the Canvas area changes', async () => {
    // A Canvas big enough to shrink the fitted rate: 400px of stage over 100px is
    // 3 display pixels per Canvas pixel, and the fit alone would give 16 once the
    // Canvas is 20px.
    const big: CharacterAlignment = {
      canvas: { width: 100, height: 100, anchor: { x: 50, y: 100 } },
      contentFloor: { width: 4, height: 4, hasContent: true },
      clips: [],
      drafts: [],
    };
    let current: CharacterAlignment = big;
    const wb = mountWorkbench(container, {
      api: fakeApi({
        readCharacterAlignment: async () => current,
        readDraftAlignment: async () => EMPTY_ALIGNMENT,
        resizeCanvas: async (_characterId, width, height) => {
          current = {
            ...big,
            canvas: { width, height, anchor: { x: width / 2, y: height } },
          };
          return {
            canvas: current.canvas,
            rebakedClips: [],
            rebakedSequences: [],
            repairWarnings: [],
          };
        },
      }),
    });
    await wb.ready;
    const stage = wb.root.querySelector('[data-region="stage"]') as HTMLElement;
    Object.defineProperty(stage, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(stage, 'clientHeight', { value: 400, configurable: true });

    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const board = wb.root.querySelector<HTMLElement>('[data-alignment-canvas]')!;
    expect(board.dataset.alignScale).toBe('3');
    expect(board.style.width).toBe('300px');

    const inspector = wb.root.querySelector('[data-region="inspector"]') as HTMLElement;
    const widthInput = inspector.querySelector('[data-resize-width]') as HTMLInputElement;
    const heightInput = inspector.querySelector('[data-resize-height]') as HTMLInputElement;
    widthInput.value = '20';
    widthInput.dispatchEvent(new Event('input'));
    heightInput.value = '20';
    heightInput.dispatchEvent(new Event('input'));
    inspector.querySelector<HTMLElement>('[data-resize-canvas-action]')!.click();
    await wb.settled();

    // The smaller Canvas is drawn at the rate it already had: the area shrank, the
    // pixels did not grow.
    const after = wb.root.querySelector<HTMLElement>('[data-alignment-canvas]')!;
    expect(after.dataset.alignScale).toBe('3');
    expect(after.style.width).toBe('60px');
    expect(after.style.height).toBe('60px');
    expect(
      wb.root.querySelector('[data-align-size-readout]')!.textContent,
    ).toBe('20 × 20');
  });

  it('offers the Canvas edges as resize handles on an editable face', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const stage = wb.root.querySelector('[data-region="stage"]') as HTMLElement;
    const edges = [...stage.querySelectorAll<HTMLElement>('[data-grip-edge]')].map(
      (grip) => grip.dataset.gripEdge,
    );
    expect(edges).toEqual(['left', 'right', 'top', 'bottom']);
    // A grip is a labelled button, so the size is reachable without a pointer.
    const left = stage.querySelector<HTMLElement>('[data-grip-edge="left"]')!;
    expect(left.tagName).toBe('BUTTON');
    expect(left.getAttribute('aria-label')).toMatch(/width/i);
  });

  it('withholds the handles where the Canvas is not edited (a committed Asset)', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.root.querySelector<HTMLElement>('[data-asset="walk"]')!.click();
    await wb.settled();
    wb.setMode('align');
    await wb.settled();

    const stage = wb.root.querySelector('[data-region="stage"]') as HTMLElement;
    expect(stage.querySelector('[data-alignment-canvas]')).not.toBeNull();
    expect(stage.querySelectorAll('[data-grip-edge]')).toHaveLength(0);
  });

  it('resizes the Canvas by dragging its edge, previewing the re-bake', async () => {
    const sized: unknown[] = [];
    let current: CharacterAlignment = ALIGNMENT;
    const wb = mountWorkbench(container, {
      api: fakeApi({
        readCharacterAlignment: async () => current,
        readDraftAlignment: async () => EMPTY_ALIGNMENT,
        resizeCanvas: async (characterId, width, height) => {
          sized.push({ characterId, width, height });
          current = { ...ALIGNMENT, canvas: { width, height, anchor: { x: width / 2, y: height } } };
          return {
            canvas: current.canvas,
            rebakedClips: [],
            rebakedSequences: [],
            repairWarnings: [],
          };
        },
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const stage = wb.root.querySelector('[data-region="stage"]') as HTMLElement;
    const board = stage.querySelector<HTMLElement>('[data-alignment-canvas]')!;
    const scale = Number(board.dataset.alignScale);
    const grip = stage.querySelector<HTMLElement>('[data-grip-edge="right"]')!;
    const at = (type: string, x: number, y: number): PointerEvent =>
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });

    grip.dispatchEvent(at('pointerdown', 100, 100));
    window.dispatchEvent(at('pointermove', 100 + 4 * scale, 100));
    // While the pointer is down the outcome is already on screen: the store's own
    // arithmetic, applied without writing. The frame grows; the picture keeps its
    // size, so the extra area is empty rather than the sprite being stretched.
    expect(board.style.width).toBe(`${12 * scale}px`);
    const image = stage.querySelector<HTMLElement>(
      '[data-align-ghost][data-draft="wip"] [data-align-ghost-image]',
    )!;
    expect(image.style.width).toBe(`${4 * scale}px`);
    expect(image.style.height).toBe(`${6 * scale}px`);
    // The bitmap is shifted by the delta the re-bake will apply (width +8 is dx 4,
    // height unchanged) so its pixels stay put while the frame's edge moves.
    expect(image.style.transform).toBe(`translate(${4 * scale}px, 0px)`);
    expect(stage.querySelector('[data-align-size-readout]')!.textContent).toBe('12 × 6');
    expect(stage.querySelector<HTMLElement>('[data-anchor]')!.dataset.anchorX).toBe('2');

    window.dispatchEvent(at('pointerup', 100 + 4 * scale, 100));
    await wb.settled();

    // Symmetric about the Anchor: four columns dragged is eight columns of width.
    expect(sized).toEqual([{ characterId: 'hero', width: 12, height: 6 }]);
  });

  it('stops an edge drag at the content floor instead of writing a refused size', async () => {
    const sized: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        readCharacterAlignment: async () => ALIGNMENT,
        readDraftAlignment: async () => EMPTY_ALIGNMENT,
        resizeCanvas: async (characterId, width, height) => {
          sized.push({ characterId, width, height });
          return {
            canvas: { width, height, anchor: { x: width / 2, y: height } },
            rebakedClips: [],
            rebakedSequences: [],
            repairWarnings: [],
          };
        },
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const stage = wb.root.querySelector('[data-region="stage"]') as HTMLElement;
    const board = stage.querySelector<HTMLElement>('[data-alignment-canvas]')!;
    const scale = Number(board.dataset.alignScale);
    const grip = stage.querySelector<HTMLElement>('[data-grip-edge="bottom"]')!;
    const at = (type: string, x: number, y: number): PointerEvent =>
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });

    // The Canvas is already the floor, so pulling inward changes nothing at all.
    grip.dispatchEvent(at('pointerdown', 10, 10));
    window.dispatchEvent(at('pointermove', 10, 10 - 5 * scale));
    expect(stage.querySelector('[data-align-size-readout]')!.textContent).toBe('4 × 6');
    window.dispatchEvent(at('pointerup', 10, 10 - 5 * scale));
    await wb.settled();
    expect(sized).toEqual([]);
  });

  it('resizes from the keyboard, one whole column of width per arrow', async () => {
    const sized: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        readCharacterAlignment: async () => ALIGNMENT,
        readDraftAlignment: async () => EMPTY_ALIGNMENT,
        resizeCanvas: async (characterId, width, height) => {
          sized.push({ characterId, width, height });
          return {
            canvas: { width, height, anchor: { x: width / 2, y: height } },
            rebakedClips: [],
            rebakedSequences: [],
            repairWarnings: [],
          };
        },
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const stage = wb.root.querySelector('[data-region="stage"]') as HTMLElement;
    const left = stage.querySelector<HTMLElement>('[data-grip-edge="left"]')!;
    // The edge travels left, so the Canvas grows: two columns, and never odd.
    left.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await wb.settled();
    expect(sized).toEqual([{ characterId: 'hero', width: 6, height: 6 }]);
  });

  it('surfaces a stale-alignment warning from the server rather than hiding it', async () => {
    const warned = fakeApi({
      readDraftAlignment: async () => ({
        offset: { x: 0, y: -1 },
        flipX: false,
        warnings: [{ code: 'alignment-framing-changed', message: 'the Canvas changed' }],
      }),
    });
    const wb = mountWorkbench(container, { api: warned });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    expect(
      wb.root.querySelector('[data-alignment-warning="alignment-framing-changed"]'),
    ).not.toBeNull();
  });

  it('places a Draft by dragging its ghost on the Canvas', async () => {
    const written: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        setPlacementOffset: async (characterId, draftId, offset) => {
          written.push({ characterId, draftId, offset });
          return DRAFT;
        },
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const ghost = wb.root.querySelector<HTMLElement>('[data-align-ghost][data-draft="wip"]')!;
    expect(ghost).not.toBeNull();
    // The board reports its display scale, so the drag is read back as a
    // whole-Canvas offset however large the fitted board is.
    const board = wb.root.querySelector<HTMLElement>('[data-alignment-canvas]')!;
    const scale = Number(board.dataset.alignScale);
    const at = (type: string, x: number, y: number): PointerEvent =>
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
    ghost.dispatchEvent(at('pointerdown', 100, 100));
    ghost.dispatchEvent(at('pointermove', 100 + 4 * scale, 100 - 2 * scale));
    ghost.dispatchEvent(at('pointerup', 100 + 4 * scale, 100 - 2 * scale));
    await wb.settled();

    expect(written).toEqual([{ characterId: 'hero', draftId: 'wip', offset: { x: 4, y: -2 } }]);
  });

  it('clips a committed Clip ghost to its first frame, not its whole sheet', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.setMode('align');
    await wb.settled();

    const stage = wb.root.querySelector('[data-region="stage"]')!;
    const board = stage.querySelector<HTMLElement>('[data-alignment-canvas]')!;
    const scale = Number(board.dataset.alignScale);
    const ghost = stage.querySelector<HTMLElement>('[data-align-ghost][data-kind="clip"]')!;
    const image = ghost.querySelector<HTMLImageElement>('[data-align-ghost-image]')!;

    // The ghost is one Canvas and clips; the sheet behind it is `frameCount` wide.
    expect(ghost.style.width).toBe(`${ALIGNMENT.canvas.width * scale}px`);
    expect(ghost.style.overflow).toBe('hidden');
    expect(image.style.width).toBe(`${ALIGNMENT.canvas.width * scale * 3}px`);
  });

  it('mirrors the Draft when the Mirror x box is ticked', async () => {
    const written: unknown[] = [];
    let mirrored = false;
    const wb = mountWorkbench(container, {
      api: fakeApi({
        setFlipX: async (characterId, draftId, flipX) => {
          written.push({ characterId, draftId, flipX });
          mirrored = flipX;
          return { ...DRAFT, flipX };
        },
        readDraftAlignment: async () => ({
          offset: { x: 0, y: 0 },
          flipX: mirrored,
          warnings: [],
        }),
        readCharacterAlignment: async () => ({
          ...ALIGNMENT,
          drafts: [{ ...ALIGNMENT.drafts[0]!, flipX: mirrored }],
        }),
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const flip = wb.root.querySelector<HTMLInputElement>('[data-align-flip]')!;
    // Mirroring is a Draft flag beside the offset, not a baked pixel, so it never
    // rewrites the Repair script.
    expect(flip.closest('.align-mirror')!.textContent).toContain('Mirror x');
    expect(flip.checked).toBe(false);

    flip.checked = true;
    flip.dispatchEvent(new Event('change', { bubbles: true }));
    await wb.settled();

    expect(written).toEqual([{ characterId: 'hero', draftId: 'wip', flipX: true }]);
    const ghost = wb.root.querySelector<HTMLElement>('[data-align-ghost][data-draft="wip"]')!;
    expect(ghost.querySelector('[data-align-ghost-image]')!.classList.contains('is-mirrored'))
      .toBe(true);
  });

  it('carries the mirror over to the Clip face it was set on', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({
        setFlipX: async (_characterId, _draftId, flipX) => ({ ...DRAFT, flipX }),
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const flip = wb.root.querySelector<HTMLInputElement>('[data-align-flip]')!;
    flip.checked = true;
    flip.dispatchEvent(new Event('change', { bubbles: true }));
    await wb.settled();

    // The Clip face paints from the held Draft, so the write has to update it.
    wb.setMode('clip');
    expect(
      wb.root.querySelector('[data-draft-sheet]')!.classList.contains('is-mirrored'),
    ).toBe(true);
  });

  it('shows a committed Clip as mirrored rather than offering a flip', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({
        readCharacterAlignment: async () => ({
          ...ALIGNMENT,
          clips: [{ ...ALIGNMENT.clips[0]!, flipX: true }],
        }),
      }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.setMode('align');
    await wb.settled();
    wb.root.querySelector<HTMLElement>('[data-align-clip-open="walk"]')!.click();
    await wb.settled();
    // Opening a Clip drops on the clip face; its placement view is Alignment.
    wb.setMode('align');
    await wb.settled();

    const inspector = wb.root.querySelector('[data-region="inspector"]')!;
    expect(inspector.querySelector('[data-align-flip]')).toBeNull();
    const key = [...inspector.querySelectorAll('dt')].find((cell) =>
      cell.textContent === 'mirror',
    )!;
    expect(key.nextElementSibling?.textContent).toBe('mirrored');
  });
});

describe('clampRange', () => {
  const cut = { id: 'walk', startFrame: 2, endFrame: 6 };

  it('drags a start edge inside the range without swallowing the end frame', () => {
    expect(clampRange('start', 4, cut, 10)).toEqual({ startFrame: 4, endFrame: 6 });
    // A start dragged past the end stops one frame short of it (half-open range).
    expect(clampRange('start', 99, cut, 10)).toEqual({ startFrame: 5, endFrame: 6 });
    expect(clampRange('start', -3, cut, 10)).toEqual({ startFrame: 0, endFrame: 6 });
  });

  it('drags an end edge up to the Recording frame count', () => {
    expect(clampRange('end', 9, cut, 10)).toEqual({ startFrame: 2, endFrame: 9 });
    expect(clampRange('end', 500, cut, 10)).toEqual({ startFrame: 2, endFrame: 10 });
    // An end dragged before the start leaves at least one frame.
    expect(clampRange('end', 0, cut, 10)).toEqual({ startFrame: 2, endFrame: 3 });
  });
});

describe('the Export stage', () => {
  it('shows the live manifest in the inspector and the target in the stage', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    wb.setMode('export');
    await wb.loadExport('pixel-pet');

    const stage = wb.root.querySelector('[data-region="stage"]')!;
    expect(stage.querySelector('[data-stage-view="export"]')).not.toBeNull();
    expect(stage.querySelector<HTMLElement>('[data-export-summary]')!.textContent).toContain(
      'pixel-pet',
    );

    const inspector = wb.root.querySelector<HTMLElement>('[data-region="inspector"]')!;
    expect(inspector.dataset.inspectorFor).toBe('export');
    const manifest = inspector.querySelector<HTMLElement>('[data-manifest]')!;
    expect(manifest).not.toBeNull();
    expect(manifest.dataset.manifestTarget).toBe('pixel-pet');
    // The inspector renders the manifest JSON the consumer would read.
    expect(manifest.textContent).toContain('"formatVersion": "1.0.0"');
    expect(manifest.textContent).toContain('"clips/walk.png"');

    expect(wb.activeExport).toBe('pixel-pet');
    expect(wb.manifest?.manifest.target).toBe('pixel-pet');
  });
});

describe('a rejected load', () => {
  /** An API whose Manifest read fails the way validate-on-read does. */
  function failingManifestApi(message: string): WorkbenchApi {
    return fakeApi({
      readManifest: async () => {
        throw new Error(message);
      },
    });
  }

  it('shows why the load failed instead of looking like a dead click', async () => {
    const wb = mountWorkbench(container, { api: failingManifestApi('manifest canvas does not equal canvas.json') });
    await wb.ready;
    wb.setMode('export');

    await wb.loadExport('pixel-pet');

    const stage = wb.root.querySelector<HTMLElement>('[data-region="stage"]')!;
    const banner = stage.querySelector<HTMLElement>('[data-load-error]')!;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('manifest canvas does not equal canvas.json');

    // The inspector says so too, so neither region looks live.
    const inspector = wb.root.querySelector<HTMLElement>('[data-region="inspector"]')!;
    expect(inspector.querySelector('[data-load-error-note]')).not.toBeNull();

    // The half-built state is dropped rather than left stale.
    expect(wb.manifest).toBeNull();
  });

  it('clears the error once a later load succeeds', async () => {
    let fail = true;
    const wb = mountWorkbench(container, {
      api: fakeApi({
        readManifest: async () => {
          if (fail) {
            throw new Error('stale manifest');
          }
          return EXPORT_RESULT;
        },
      }),
    });
    await wb.ready;
    wb.setMode('export');
    await wb.loadExport('pixel-pet');
    expect(wb.root.querySelector('[data-load-error]')).not.toBeNull();

    fail = false;
    await wb.loadExport('pixel-pet');

    expect(wb.root.querySelector('[data-load-error]')).toBeNull();
    expect(wb.manifest?.manifest.target).toBe('pixel-pet');
  });
});

describe('importing a capture', () => {
  /** A File of arbitrary bytes, as the file input would hand over. */
  function gifFile(name = 'My Capture!.gif'): File {
    return new File([new Uint8Array([71, 73, 70, 56, 57, 97])], name, {
      type: 'image/gif',
    });
  }

  it('derives a legal id from the filename and imports on submit', async () => {
    const seen: { id: string; filename?: string }[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        ingestRecording: async (id, _data, filename) => {
          seen.push({ id, filename });
          return {
            id,
            dir: `recordings/${id}`,
            hash: `sha256:${'c'.repeat(64)}`,
            frameCount: 4,
            delaysMs: [50, 50, 60, 50],
          };
        },
      }),
    });
    await wb.ready;

    const rail = openRailForm(wb, 'import');
    const fileInput = rail.querySelector<HTMLInputElement>('[data-import-file]')!;
    const idInput = rail.querySelector<HTMLInputElement>('[data-import-id]')!;
    expect(idInput.value).toBe('');

    // A picked file seeds the id from its name.
    Object.defineProperty(fileInput, 'files', { value: [gifFile()], configurable: true });
    fileInput.dispatchEvent(new Event('change'));
    expect(idInput.value).toBe('my-capture');

    rail.querySelector<HTMLFormElement>('[data-import-form]')!.requestSubmit();
    await wb.settled();

    expect(seen).toEqual([{ id: 'my-capture', filename: 'My Capture!.gif' }]);
    // The imported Recording is the active one, so cutting can start at once.
    expect(wb.activeRecording).toBe('my-capture');
  });

  it('stops following the filename once the user types an id', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    const rail = openRailForm(wb, 'import');
    const fileInput = rail.querySelector<HTMLInputElement>('[data-import-file]')!;
    const idInput = rail.querySelector<HTMLInputElement>('[data-import-id]')!;

    idInput.value = 'boss-fight';
    idInput.dispatchEvent(new Event('input'));
    Object.defineProperty(fileInput, 'files', { value: [gifFile()], configurable: true });
    fileInput.dispatchEvent(new Event('change'));

    expect(idInput.value).toBe('boss-fight');
  });

  it('reports the server message when the import is rejected', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({
        ingestRecording: async () => {
          throw new Error('Invalid recording id "x": must match /^[a-z][a-z0-9-]*$/.');
        },
      }),
    });
    await wb.ready;

    const rail = openRailForm(wb, 'import');
    const fileInput = rail.querySelector<HTMLInputElement>('[data-import-file]')!;
    Object.defineProperty(fileInput, 'files', { value: [gifFile()], configurable: true });
    fileInput.dispatchEvent(new Event('change'));

    rail.querySelector<HTMLFormElement>('[data-import-form]')!.requestSubmit();
    await wb.settled();

    expect(
      rail.querySelector<HTMLElement>('[data-import-message]')!.textContent,
    ).toContain('must match');
  });

  it('asks for a file when none is picked', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    const rail = openRailForm(wb, 'import');
    rail.querySelector<HTMLFormElement>('[data-import-form]')!.requestSubmit();
    await wb.settled();

    expect(
      rail.querySelector<HTMLElement>('[data-import-message]')!.textContent,
    ).toContain('pick a capture');
  });

  it('slugifies filenames into the id grammar', () => {
    expect(slugifyId('My Capture!.gif')).toBe('my-capture');
    expect(slugifyId('2026-09-01 run.gif')).toBe('rec-2026-09-01-run');
    expect(slugifyId('+++.gif')).toBe('recording');
  });
});

describe('the recording workspace', () => {
  it('puts the Import form above the list of already-imported Recordings', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    const rail = openRailForm(wb, 'import');
    const form = rail.querySelector('[data-import-form]')!;
    const first = rail.querySelector('[data-recording]')!;

    // Document order: the form comes first, the existing recordings after it.
    expect(form.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('previews the active Recording frame in the Clip editor', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadRecording('idle');

    const img = wb.root.querySelector<HTMLImageElement>('[data-recording-frame]')!;
    expect(img.getAttribute('src')).toBe('/api/recordings/idle/frames/0');

    // Stepping moves the preview, so a segment can be cut at the right frame.
    wb.root.querySelector<HTMLElement>('[data-frame-step="next"]')!.click();
    expect(wb.activeFrame).toBe(1);
    expect(wb.root.querySelector('[data-recording-frame]')!.getAttribute('src')).toBe(
      '/api/recordings/idle/frames/1',
    );
  });

  it('saves a marked range as a Segment, then renames and deletes it', async () => {
    const added: unknown[] = [];
    const removed: string[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        addSegment: async (_id, segment) => {
          added.push(segment);
          // The store answers with the cut list it now holds, so the new cut is in it.
          return { ...CUTS, cuts: [...CUTS.cuts, { ...segment, id: segment.id }] };
        },
        removeSegment: async (_id, cutId) => {
          removed.push(cutId);
          return CUTS;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');

    // Cutting is a gesture on the strip: mark from the playhead, then save it.
    wb.root.querySelector<HTMLElement>('[data-frame="2"]')!.click();
    await saveSegmentAtPlayhead(wb, 'jump');
    expect(added).toEqual([{ id: 'jump', startFrame: 2, endFrame: 3 }]);

    const inspector = wb.root.querySelector('[data-region="inspector"]')!;
    inspector.querySelector<HTMLElement>('[data-segment-delete="jump"]')!.click();
    answerDialog();
    await wb.settled();
    expect(removed).toEqual(['jump']);
  });

  it('asks which Character a new Segment is for, and points Extract at it', async () => {
    const added: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        scan: async () => ({
          ...SCAN,
          characters: [
            ...SCAN.characters,
            { id: 'me', dir: 'characters/me', assets: [], drafts: [], sequenceDrafts: [] },
          ],
        }),
        addSegment: async (_id, segment) => {
          added.push(segment);
          return { ...CUTS, cuts: [...CUTS.cuts, { ...segment, id: segment.id }] };
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');
    await wb.ready;

    // There is no standing "extract into" field: the Character is asked for when
    // the cut is kept, from the same strip action that keeps it.
    expect(wb.root.querySelector('[data-extract-character]')).toBeNull();
    wb.root.querySelector<HTMLElement>('[data-frame="2"]')!.click();
    measureTrack();
    const track = wb.root.querySelector<HTMLElement>('[data-region="filmstrip"] [data-pick]')!;
    track.dispatchEvent(pointer('pointerdown', 25));
    window.dispatchEvent(pointer('pointerup', 25));
    wb.root.querySelector<HTMLElement>('[data-pick-save]')!.click();
    answerDialog(true, 'jump');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The choice lists the Characters that exist, and a way to make a new one —
    // the latter set apart, so it cannot be taken for one more Character.
    const choices = [...document.querySelectorAll<HTMLInputElement>('[data-dialog-choice]')].map(
      (radio) => radio.value,
    );
    expect(choices).toEqual(['hero', 'me', '\u0000 new']);
    const rows = [...document.querySelectorAll<HTMLElement>('.dialog-choice')];
    expect(rows.slice(0, 2).every((row) => !row.classList.contains('is-create'))).toBe(true);
    expect(rows[rows.length - 1]!.classList.contains('is-create')).toBe(true);

    // Picking one that is not the default shows up as the Extract target.
    document.querySelector<HTMLInputElement>('[data-dialog-choice="me"]')!.checked = true;
    answerDialog(true);
    await wb.settled();

    expect(added).toHaveLength(1);
    const extract = wb.root.querySelector<HTMLElement>('[data-segment-extract="jump"]')!;
    expect(extract.textContent).toBe('Extract');
  });

  it('creates the Character while saving when asked for a new one', async () => {
    const created: Array<{ id: string; canvas: unknown }> = [];
    const calls: string[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        addSegment: async (_id, segment) => {
          calls.push('cut');
          return { ...CUTS, cuts: [...CUTS.cuts, { ...segment, id: segment.id }] };
        },
        deriveAnchor: async () => {
          calls.push('derive');
          return {
            frame: 0,
            bounds: { x: 0, y: 0, width: 4, height: 6 },
            anchor: { x: 2, y: 6 },
            canvas: { width: 4, height: 6, anchor: { x: 2, y: 6 } },
          } as DerivedAnchor;
        },
        createCharacter: async (id, canvas) => {
          created.push({ id, canvas });
          return { id, dir: `characters/${id}` } as unknown as CreatedCharacter;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');
    measureTrack();

    wb.root.querySelector<HTMLElement>('[data-frame="2"]')!.click();
    const track = wb.root.querySelector<HTMLElement>('[data-region="filmstrip"] [data-pick]')!;
    track.dispatchEvent(pointer('pointerdown', 25));
    window.dispatchEvent(pointer('pointerup', 25));
    wb.root.querySelector<HTMLElement>('[data-pick-save]')!.click();
    answerDialog(true, 'jump');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The new-Character row is the last one offered, whatever its value looks like.
    const radios = [...document.querySelectorAll<HTMLInputElement>('[data-dialog-choice]')];
    radios[radios.length - 1]!.checked = true;
    answerDialog(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    answerDialog(true, 'kitty');
    await wb.settled();

    // The cut is stored before the framing is derived: the Anchor reads a real cut.
    expect(calls).toEqual(['cut', 'derive']);
    expect(created).toEqual([
      { id: 'kitty', canvas: { width: 4, height: 6, anchorX: 2, anchorY: 6 } },
    ]);
  });

  it('writes nothing when the save dialog is dismissed at the Character step', async () => {
    const added: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        addSegment: async (_id, segment) => {
          added.push(segment);
          return CUTS;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');
    measureTrack();

    wb.root.querySelector<HTMLElement>('[data-frame="2"]')!.click();
    const track = wb.root.querySelector<HTMLElement>('[data-region="filmstrip"] [data-pick]')!;
    track.dispatchEvent(pointer('pointerdown', 25));
    window.dispatchEvent(pointer('pointerup', 25));
    wb.root.querySelector<HTMLElement>('[data-pick-save]')!.click();
    answerDialog(true, 'jump');
    await new Promise((resolve) => setTimeout(resolve, 0));
    answerDialog(false);
    await wb.settled();

    expect(added).toEqual([]);
    // The marked range survives, so the cut can be retried without re-dragging.
    expect(wb.root.querySelector('[data-pick-save]')).not.toBeNull();
  });

  it('keeps a segment when the delete confirmation is dismissed', async () => {
    const removed: string[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        removeSegment: async (_id, cutId) => {
          removed.push(cutId);
          return CUTS;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');

    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await selectSegment(wb, 'walk');
    const inspector = wb.root.querySelector('[data-region="inspector"]')!;
    inspector.querySelector<HTMLElement>('[data-segment-delete="walk"]')!.click();
    answerDialog(false);
    await wb.settled();
    expect(removed).toEqual([]);
  });

  it('renames a segment through the ask', async () => {
    const renamed: string[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        renameSegment: async (_id, cutId, newId) => {
          renamed.push(`${cutId}->${newId}`);
          return CUTS;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');

    await selectSegment(wb, 'walk');
    wb.root.querySelector<HTMLElement>('[data-segment-rename="walk"]')!.click();
    answerDialog(true, 'stride');
    await wb.settled();
    expect(renamed).toEqual(['walk->stride']);
  });

  it('separates the cut itself from the verb that makes something else', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadRecording('idle');
    await selectSegment(wb, 'walk');
    const detail = wb.root.querySelector<HTMLElement>('[data-segment-detail="walk"]')!;

    // The name and its range are two lines, in that order: the range is data about
    // the cut, not part of its name.
    const name = detail.querySelector<HTMLElement>('.segment-name')!;
    const frames = detail.querySelector<HTMLElement>('.segment-frames')!;
    expect(name.textContent).toBe('walk');
    expect(frames.textContent).toBe('frames 1–3');
    expect(name.compareDocumentPosition(frames)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // Rename is a mark on the name, so it sits in the head beside it; Delete is
    // about the whole block, so it goes last in that head — the far corner.
    const head = detail.querySelector<HTMLElement>('.segment-head')!;
    const rename = head.querySelector<HTMLElement>('[data-segment-rename="walk"]')!;
    const remove = head.querySelector<HTMLElement>('[data-segment-delete="walk"]')!;
    expect(head.children[0]).toBe(name);
    expect(head.lastElementChild).toBe(remove);
    expect(remove.previousElementSibling).toBe(rename);
    // Icons carry no visible word, so the name has to come from aria-label.
    expect(rename.getAttribute('aria-label')).toContain('Rename segment');

    // Extract is the only verb that leaves the Segment, so it is its own full-width
    // row at the end rather than a third icon.
    const extract = detail.querySelector<HTMLElement>('[data-segment-extract="walk"]')!;
    expect(detail.lastElementChild).toBe(extract);
    expect(extract.classList.contains('segment-extract')).toBe(true);
  });

  it('frames a new Character from a chosen Segment by default', async () => {
    const created: Array<{ id: string; canvas: unknown }> = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        createCharacter: async (id, canvas) => {
          created.push({ id, canvas });
          return { id, dir: `characters/${id}` } as unknown as CreatedCharacter;
        },
      }),
    });
    await wb.ready;

    const rail = openRailForm(wb, 'character');
    (rail.querySelector('[data-character-id]') as HTMLInputElement).value = 'hero';
    // Segment framing is the default source, so its pickers are already shown.
    expect(rail.querySelector('[data-character-source]')).not.toBeNull();
    expect((rail.querySelector('[data-character-source]') as HTMLSelectElement).value).toBe(
      'segment',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    (rail.querySelector('[data-character-recording-source]') as HTMLSelectElement).value = 'idle';
    (rail.querySelector('[data-character-segment-source]') as HTMLSelectElement).value = 'walk';
    (rail.querySelector('[data-character-add]') as HTMLFormElement).requestSubmit();
    await wb.settled();

    // The Canvas is the Segment's framing, never a guessed default.
    expect(created).toEqual([
      { id: 'hero', canvas: { width: 4, height: 6, anchorX: 2, anchorY: 6 } },
    ]);
    expect(wb.mode).toBe('align');
  });

  it('creates a blank Character without needing a Recording', async () => {
    const created: Array<{ id: string; canvas: unknown }> = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        createCharacter: async (id, canvas) => {
          created.push({ id, canvas });
          return { id, dir: `characters/${id}` } as unknown as CreatedCharacter;
        },
      }),
    });
    await wb.ready;

    // Characters are their own Library level, so the form opens in the rail, not
    // under the Recording's frame.
    const rail = openRailForm(wb, 'character');
    (rail.querySelector('[data-character-id]') as HTMLInputElement).value = 'hero';
    // The blank escape hatch is a source choice, not the default.
    (rail.querySelector('[data-character-source]') as HTMLSelectElement).value = 'blank';
    (rail.querySelector('[data-character-source]') as HTMLSelectElement).dispatchEvent(
      new Event('change'),
    );
    (rail.querySelector('[data-character-add]') as HTMLFormElement).requestSubmit();
    await wb.settled();

    // No Canvas: the Character starts on the provisional one and is framed later.
    expect(created).toEqual([{ id: 'hero', canvas: undefined }]);
    // A new Character opens on its Alignment face.
    expect(wb.mode).toBe('align');
  });

  it('opens a Character from the Library on its Alignment face', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    const rail = wb.root.querySelector('[data-region="rail"]')!;
    rail.querySelector<HTMLElement>('[data-character="hero"]')!.click();
    await wb.settled();

    expect(wb.mode).toBe('align');
    expect(wb.alignment).not.toBeNull();
    expect(wb.root.querySelector('[data-alignment-canvas]')).not.toBeNull();
  });

  /**
   * The Alignment face is where a Character lands, so that is where footage is
   * opened: the inspector carries the Recording picker and the way to import one
   * when none exist yet.
   */
  it('opens a Recording for the Character from its Alignment inspector', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openCharacter(wb, 'hero');

    const form = wb.root.querySelector<HTMLFormElement>(
      '[data-character-recording-form]',
    )!;
    expect(form).not.toBeNull();
    (form.querySelector('[data-character-recording]') as HTMLSelectElement).value = 'fat-walk';
    form.requestSubmit();
    await wb.settled();

    expect(wb.activeRecording).toBe('fat-walk');
  });

  it('points an empty Character inspector at importing a Recording', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({ scan: async () => ({ ...SCAN, recordings: [] }) }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');

    const inspector = wb.root.querySelector('[data-region="inspector"]')!;
    expect(inspector.querySelector('[data-character-recording-open]')).toBeNull();
    inspector.querySelector<HTMLElement>('[data-character-recording-import]')!.click();
    await wb.settled();

    expect(wb.root.querySelector('[data-region="rail"] [data-import-file]')).not.toBeNull();
  });

  it('frames the Canvas from the open Recording', async () => {
    const framed: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        // A framing the Canvas does not already have, above the floor.
        deriveAnchor: async () =>
          ({
            frame: 0,
            bounds: { x: 0, y: 0, width: 6, height: 8 },
            anchor: { x: 3, y: 8 },
            canvas: { width: 6, height: 8, anchor: { x: 3, y: 8 } },
          }) as DerivedAnchor,
        frameCanvas: async (characterId, request) => {
          framed.push({ characterId, ...request });
          return { width: 6, height: 8, anchor: { x: 3, y: 8 } };
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');
    await wb.loadCharacter('hero');
    await wb.settled();

    const button = wb.root.querySelector<HTMLButtonElement>('[data-frame-canvas-run]');
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(false);
    button!.click();
    await wb.settled();

    expect(framed).toEqual([{ characterId: 'hero', recordingId: 'idle' }]);
  });

  it('disables framing when the frame would crop drawn content', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({
        // The floor is larger than what this frame implies.
        deriveAnchor: async () =>
          ({
            frame: 0,
            bounds: { x: 0, y: 0, width: 2, height: 2 },
            anchor: { x: 1, y: 2 },
            canvas: { width: 2, height: 2, anchor: { x: 1, y: 2 } },
          }) as DerivedAnchor,
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');
    await wb.loadCharacter('hero');
    await wb.settled();

    const button = wb.root.querySelector<HTMLButtonElement>('[data-frame-canvas-run]')!;
    expect(button.disabled).toBe(true);
    expect(wb.root.querySelector('[data-frame-canvas-note]')!.textContent).toMatch(
      /content floor/i,
    );
  });

  it('disables framing when the Canvas already matches the frame', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({
        deriveAnchor: async () =>
          ({
            frame: 0,
            bounds: { x: 0, y: 0, width: 4, height: 6 },
            anchor: { x: 2, y: 6 },
            canvas: { width: 4, height: 6, anchor: { x: 2, y: 6 } },
          }) as DerivedAnchor,
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');
    await wb.loadCharacter('hero');
    await wb.settled();

    const button = wb.root.querySelector<HTMLButtonElement>('[data-frame-canvas-run]')!;
    expect(button.disabled).toBe(true);
    expect(wb.root.querySelector('[data-frame-canvas-note]')!.textContent).toMatch(
      /already framed/i,
    );
  });

  it('disables a resize the store would refuse, naming the rule', async () => {
    const sized: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        resizeCanvas: async (characterId, width, height) => {
          sized.push({ characterId, width, height });
          return {
            canvas: { width, height, anchor: { x: width / 2, y: height } },
            rebakedClips: [],
            rebakedSequences: [],
            repairWarnings: [],
          };
        },
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const inspector = wb.root.querySelector<HTMLElement>('[data-region="inspector"]')!;
    const widthInput = inspector.querySelector<HTMLInputElement>('[data-resize-width]')!;
    const heightInput = inspector.querySelector<HTMLInputElement>('[data-resize-height]')!;
    const resize = inspector.querySelector<HTMLButtonElement>('[data-resize-canvas-action]')!;
    const floorNote = inspector.querySelector<HTMLElement>('[data-align-floor]')!;

    // Below the content floor.
    widthInput.value = '2';
    widthInput.dispatchEvent(new Event('input'));
    heightInput.value = '2';
    heightInput.dispatchEvent(new Event('input'));
    expect(resize.disabled).toBe(true);
    expect(floorNote.textContent).toMatch(/content floor/i);

    // Odd width: the Anchor could not sit at the centre.
    widthInput.value = '5';
    widthInput.dispatchEvent(new Event('input'));
    heightInput.value = '8';
    heightInput.dispatchEvent(new Event('input'));
    expect(resize.disabled).toBe(true);
    expect(floorNote.textContent).toMatch(/even/i);

    // A size it can take.
    widthInput.value = '6';
    widthInput.dispatchEvent(new Event('input'));
    heightInput.value = '8';
    heightInput.dispatchEvent(new Event('input'));
    expect(resize.disabled).toBe(false);
    resize.click();
    await wb.settled();
    expect(sized).toEqual([{ characterId: 'hero', width: 6, height: 8 }]);
  });

  it('extracts a segment straight into a Draft on the same screen', async () => {
    const extracted: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        extractClipDraft: async (characterId, request) => {
          extracted.push({ characterId, ...request });
          return DRAFT;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');

    await selectSegment(wb, 'walk');
    const extract = wb.root.querySelector<HTMLElement>('[data-segment-extract="walk"]')!;
    // One label whatever the state: the ask, not the wording, carries the choice.
    expect(extract.textContent).toBe('Extract');
    extract.click();
    // No target was chosen, so Extract asks which Character to use.
    answerDialog();
    // Then it asks for the Draft name, prefilled with the Segment's own id.
    await answerDialogAfterHop();
    await wb.settled();

    expect(extracted).toEqual([
      { characterId: 'hero', recordingId: 'idle', cutId: 'walk', draftId: 'walk' },
    ]);
    // The new Draft is open on Placement, where it is positioned before painting.
    expect(wb.activeDraft).toEqual({ characterId: 'hero', draftId: 'wip' });
    expect(wb.root.querySelector('[data-stage-view="alignment"]')).not.toBeNull();
  });

  it('extracts the same Segment into a second Draft instead of replacing the first', async () => {
    const extracted: Array<{ draftId?: string }> = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        // The Segment's own id is already a Draft of this Character.
        scan: async () => ({
          ...SCAN,
          characters: SCAN.characters.map((character) =>
            character.id === 'hero'
              ? { ...character, drafts: [...character.drafts, { id: 'walk', dir: 'characters/hero/drafts/walk' }] }
              : character,
          ),
        }),
        extractClipDraft: async (_characterId, request) => {
          extracted.push(request);
          return DRAFT;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');

    await selectSegment(wb, 'walk');
    wb.root.querySelector<HTMLElement>('[data-segment-extract="walk"]')!.click();
    answerDialog();
    await answerDialogAfterHop();
    await wb.settled();

    // The prefilled name steps past the one in use, so nothing is overwritten.
    expect(extracted.map((request) => request.draftId)).toEqual(['walk-2']);
  });

  it('refreshes an existing Draft when its name is kept', async () => {
    const extracted: Array<{ draftId?: string }> = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        scan: async () => ({
          ...SCAN,
          characters: SCAN.characters.map((character) =>
            character.id === 'hero'
              ? { ...character, drafts: [...character.drafts, { id: 'walk', dir: 'characters/hero/drafts/walk' }] }
              : character,
          ),
        }),
        extractClipDraft: async (_characterId, request) => {
          extracted.push(request);
          return DRAFT;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');

    await selectSegment(wb, 'walk');
    wb.root.querySelector<HTMLElement>('[data-segment-extract="walk"]')!.click();
    answerDialog();
    // Typing the taken name is the explicit "refresh this Draft".
    await answerDialogAfterHop(true, 'walk');
    await wb.settled();

    expect(extracted.map((request) => request.draftId)).toEqual(['walk']);
  });

  it('creates the Character on extract when there is none to point at', async () => {
    const created: Array<{ id: string; canvas: unknown }> = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        scan: async () => ({ ...SCAN, characters: [] }),
        deriveAnchor: async () =>
          ({
            frame: 0,
            bounds: { x: 0, y: 0, width: 4, height: 6 },
            anchor: { x: 2, y: 6 },
            canvas: { width: 4, height: 6, anchor: { x: 2, y: 6 } },
          }) as DerivedAnchor,
        createCharacter: async (id, canvas) => {
          created.push({ id, canvas });
          return { id, dir: `characters/${id}` } as unknown as CreatedCharacter;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');

    await selectSegment(wb, 'walk');
    const button = wb.root.querySelector<HTMLElement>('[data-segment-extract="walk"]')!;
    // The label never changes; with no Character at all the ask is the first thing
    // that happens, and it can only offer a new one.
    expect(button.textContent).toBe('Extract');
    button.click();
    answerDialog(true, 'kitty');
    // Naming the new Character is followed by naming its first Draft.
    await answerDialogAfterHop();
    await wb.settled();

    // The new Character is framed from the Segment, so the pixels fit on arrival.
    expect(created).toEqual([
      { id: 'kitty', canvas: { width: 4, height: 6, anchorX: 2, anchorY: 6 } },
    ]);
    expect(wb.activeDraft).toEqual({ characterId: 'kitty', draftId: 'wip' });
  });

  it('leaves the Recording alone when the new Character is cancelled', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({ scan: async () => ({ ...SCAN, characters: [] }) }),
    });
    await wb.ready;
    await wb.loadRecording('idle');

    await selectSegment(wb, 'walk');
    wb.root.querySelector<HTMLElement>('[data-segment-extract="walk"]')!.click();
    answerDialog(false);
    await wb.settled();

    expect(wb.activeDraft).toBeNull();
    expect(wb.root.querySelector('[data-segment-extract="walk"]')).not.toBeNull();
  });

  it('commits the open Draft into a Clip', async () => {
    const committed: string[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        commitDraft: async (characterId, draftId, name) => {
          committed.push(`${characterId}/${draftId}->${name}`);
          return { kind: 'clip', id: name } as unknown as CommittedAsset;
        },
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    const inspector = wb.root.querySelector('[data-region="inspector"]')!;
    (inspector.querySelector('[data-commit-name]') as HTMLInputElement).value = 'walk';
    inspector.querySelector<HTMLElement>('[data-commit-run]')!.click();
    await wb.settled();

    expect(committed).toEqual(['hero/wip->walk']);
    // Committing consumes the Draft, so the workspace shows the new Clip playing.
    expect(wb.mode).toBe('view');
    expect(wb.activeDraft).toBeNull();
    expect(wb.root.querySelector('[data-asset-frame]')).not.toBeNull();
  });
});

describe('committed assets', () => {
  it('opens a Clip from the Library and plays its baked sheet', async () => {
    const sheets: string[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        sheetUrl: (characterId, kind, id) => {
          sheets.push(`${characterId}/${kind}/${id}`);
          return `/api/characters/${characterId}/clips/${id}/sheet`;
        },
      }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');

    // Opening a Character re-renders the rail; only the playback's own requests
    // from here on are the ones under test.
    sheets.length = 0;
    wb.root.querySelector<HTMLElement>('[data-asset="walk"]')!.click();
    await wb.settled();

    // An asset is immutable, so opening one lands on a read-only playback face.
    expect(wb.mode).toBe('view');
    // The sheet is addressed once per render of the playback, always the same one.
    expect(new Set(sheets)).toEqual(new Set(['hero/clip/walk']));
    const frame = wb.root.querySelector<HTMLElement>('[data-asset-frame]');
    expect(frame?.dataset.assetFrame).toBe('0');
    expect(wb.root.querySelector('[data-inspector-section="asset"]')).not.toBeNull();
  });

  it('sizes the frame box to one frame rather than the whole stage', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.root.querySelector<HTMLElement>('[data-asset="walk"]')!.click();
    await wb.settled();

    const frame = wb.root.querySelector<HTMLImageElement>('[data-asset-frame]')!;
    // jsdom does not decode, so the size the fit needs is stated by hand.
    Object.defineProperty(frame, 'naturalWidth', { value: 220, configurable: true });
    Object.defineProperty(frame, 'naturalHeight', { value: 20, configurable: true });
    frame.dispatchEvent(new Event('load'));

    const box = wb.root.querySelector<HTMLElement>('.sheet-box')!;
    // Three frames of 220px in one sheet, at 1:1 because the stage measures 0 here:
    // the crop window is one 220/3 x 20 frame, not the whole strip.
    expect(box.style.width).toBe(`${220 / 3}px`);
    expect(box.style.height).toBe('20px');
  });

  it('steps the playback through the sheet without leaving the Asset', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.root.querySelector<HTMLElement>('[data-asset="walk"]')!.click();
    await wb.settled();

    const stage = wb.root.querySelector('[data-region="stage"]')!;
    stage.querySelectorAll<HTMLElement>('[data-asset-viewer] button')[1]!.click();
    await wb.settled();
    expect(
      stage.querySelector<HTMLElement>('[data-asset-frame]')!.dataset.assetFrame,
    ).toBe('1');
  });

  it('forks a Clip into a Draft with the id the user typed', async () => {
    const forks: string[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        forkClip: async (characterId, clipId, draftId) => {
          forks.push(`${characterId}/${clipId}/${draftId}`);
          return DRAFT;
        },
      }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.root.querySelector<HTMLElement>('[data-asset="walk"]')!.click();
    await wb.settled();

    const inspector = wb.root.querySelector('[data-region="inspector"]')!;
    (inspector.querySelector('[data-fork-id]') as HTMLInputElement).value = 'walk-fix';
    inspector.querySelector<HTMLElement>('[data-fork-run]')!.click();
    await wb.settled();

    expect(forks).toEqual(['hero/walk/walk-fix']);
    expect(wb.activeDraft).toEqual({ characterId: 'hero', draftId: 'wip' });
  });

  it('reports a reproducibility check on the open Asset', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({
        verifyReproducible: async (_characterId, kind, id) => ({
          kind,
          id,
          reproducible: false,
          artifacts: [`characters/hero/clips/${id}/sheet.png`],
          excluded: [],
          mismatches: [{ artifact: 'sheet.png', detail: 'bytes differ' }],
        }),
      }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.root.querySelector<HTMLElement>('[data-asset="walk"]')!.click();
    await wb.settled();

    wb.root.querySelector<HTMLElement>('[data-asset-verify]')!.click();
    await wb.settled();

    const report = wb.root.querySelector<HTMLElement>('[data-asset-reproducible]');
    expect(report?.textContent).toContain('bytes differ');
  });

  it('deletes an Asset only after the confirmation', async () => {
    const deleted: string[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        deleteAsset: async (characterId, kind, id) => {
          deleted.push(`${characterId}/${kind}/${id}`);
        },
      }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.root.querySelector<HTMLElement>('[data-asset="walk"]')!.click();
    await wb.settled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wb.root.querySelector<HTMLElement>('[data-asset-delete]')!.click();
    answerDialog();
    await wb.settled();

    expect(deleted).toEqual(['hero/clip/walk']);
  });

  it('shows a refused delete in the action banner', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({
        deleteAsset: async () => {
          throw new Error('Clip "walk" is still used by Sequence "greeting".');
        },
      }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.root.querySelector<HTMLElement>('[data-asset="walk"]')!.click();
    await wb.settled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wb.root.querySelector<HTMLElement>('[data-asset-delete]')!.click();
    answerDialog();
    await wb.settled();

    expect(wb.root.querySelector('[data-action-error]')?.textContent).toContain('greeting');
    // The Asset is still open: a refused edit is not a lost load.
    expect(wb.root.querySelector('[data-asset-frame]')).not.toBeNull();
  });
});

describe('sequence composition', () => {
  it('starts a persistence-backed composition on the Character', async () => {
    const saves: Array<{ characterId: string; clips: string[] }> = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        saveSequenceDraft: async (characterId, request) => {
          saves.push({ characterId, clips: request.clips });
          return {
            id: request.draftId ?? 'composition',
            characterId,
            clips: [...request.clips],
            forkOf: null,
            spriteForgeVersion: '0.1.0',
            dir: `characters/${characterId}/sequence-drafts/composition`,
          };
        },
      }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.setMode('compose');

    wb.root.querySelector<HTMLElement>('[data-sequence-new]')!.click();
    await wb.settled();

    expect(saves).toEqual([{ characterId: 'hero', clips: [] }]);
    expect(wb.root.querySelector('[data-sequence-list]')).not.toBeNull();

    // Adding a Clip writes the composition through, so a reload can resume it.
    wb.root.querySelector<HTMLElement>('[data-sequence-add-run]')!.click();
    await wb.settled();
    expect(saves.at(-1)).toEqual({ characterId: 'hero', clips: ['walk'] });
  });

  it('omits forkOf when the composition is not forked', async () => {
    const requests: Array<{ draftId?: string; clips: string[]; forkOf?: string | null }> = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        saveSequenceDraft: async (characterId, request) => {
          requests.push(request);
          return {
            id: request.draftId ?? 'composition',
            characterId,
            clips: [...request.clips],
            forkOf: request.forkOf ?? null,
            spriteForgeVersion: '0.1.0',
            dir: `characters/${characterId}/sequence-drafts/composition`,
          };
        },
      }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.setMode('compose');

    wb.root.querySelector<HTMLElement>('[data-sequence-new]')!.click();
    await wb.settled();
    wb.root.querySelector<HTMLElement>('[data-sequence-add-run]')!.click();
    await wb.settled();

    // Every save carries the Clip list; none carries a `forkOf` key at all.
    expect(requests.every((request) => !('forkOf' in request))).toBe(true);
    expect(wb.root.querySelectorAll('[data-sequence-clip]')).toHaveLength(1);
    expect(wb.root.querySelector('[data-action-error]')).toBeNull();
  });

  it('reorders and commits the composition, consuming its draft', async () => {
    const commits: Array<{ name: string; clips: string[]; draftId?: string }> = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        saveSequenceDraft: async (characterId, request) => ({
          id: request.draftId ?? 'composition',
          characterId,
          clips: [...request.clips],
          forkOf: request.forkOf ?? null,
          spriteForgeVersion: '0.1.0',
          dir: `characters/${characterId}/sequence-drafts/composition`,
        }),
        commitSequence: async (_characterId, sequenceId, clips, draftId) => {
          commits.push({ name: sequenceId, clips, ...(draftId === undefined ? {} : { draftId }) });
          return { ...SEQUENCE, id: sequenceId, provenance: { ...SEQUENCE.provenance, clips } };
        },
      }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.setMode('compose');

    wb.root.querySelector<HTMLElement>('[data-sequence-new]')!.click();
    await wb.settled();
    // Two entries, then the second moves up.
    wb.root.querySelector<HTMLElement>('[data-sequence-add-run]')!.click();
    await wb.settled();
    wb.root.querySelector<HTMLElement>('[data-sequence-add-run]')!.click();
    await wb.settled();
    wb.root.querySelectorAll<HTMLElement>('[data-sequence-up]')[1]!.click();
    await wb.settled();

    const name = wb.root.querySelector<HTMLInputElement>('[data-sequence-name]')!;
    name.value = 'greet-walk';
    wb.root.querySelector<HTMLElement>('[data-sequence-commit]')!.click();
    await wb.settled();

    expect(commits).toEqual([
      { name: 'greet-walk', clips: ['walk', 'walk'], draftId: 'composition' },
    ]);
    expect(wb.mode).toBe('view');
  });

  it('forks a Sequence into a persisted composition on the Character', async () => {
    const saved: Array<{ clips: string[]; forkOf?: string | null }> = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        saveSequenceDraft: async (characterId, request) => {
          saved.push({ clips: request.clips, forkOf: request.forkOf });
          return {
            id: 'composition',
            characterId,
            clips: [...request.clips],
            forkOf: request.forkOf ?? null,
            spriteForgeVersion: '0.1.0',
            dir: `characters/${characterId}/sequence-drafts/composition`,
          };
        },
      }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.root.querySelector<HTMLElement>('[data-asset="greeting"]')!.click();
    await wb.settled();

    wb.root.querySelector<HTMLElement>('[data-fork-run]')!.click();
    await wb.settled();

    expect(saved).toEqual([{ clips: ['walk', 'greeting'], forkOf: 'greeting' }]);
    expect(wb.mode).toBe('compose');
    expect(wb.root.querySelector('[data-stage-view="compose"]')).not.toBeNull();
    const items = wb.root.querySelectorAll<HTMLElement>('[data-sequence-clip]');
    expect([...items].map((item) => item.dataset.sequenceClip)).toEqual(['walk', 'greeting']);
  });
});

describe('composition preview', () => {
  /** A clip with its own frame count and per-frame delays. */
  function clip(id: string, frameCount: number, delaysMs: number[]): CommittedAsset {
    return { ...CLIP, id, meta: { id, frameCount, delaysMs, loop: true } };
  }

  /** A scan holding `a` and `b` as committed Clips of `hero`. */
  function twoClipScan(): StoreScan {
    return {
      ...SCAN,
      characters: [
        {
          ...SCAN.characters[0]!,
          assets: [
            { kind: 'clip', id: 'a', dir: 'characters/hero/clips/a' },
            { kind: 'clip', id: 'b', dir: 'characters/hero/clips/b' },
          ],
          sequenceDrafts: [
            { id: 'composition', dir: 'characters/hero/sequence-drafts/composition' },
          ],
        },
      ],
    };
  }

  /** Mount with an empty composition already open, holding `a` then `b`. */
  async function composing(
    api: Parameters<typeof fakeApi>[0] = {},
  ): Promise<ReturnType<typeof mountWorkbench>> {
    const wb = mountWorkbench(container, {
      api: fakeApi({
        scan: async () => twoClipScan(),
        readClip: async (_characterId, clipId) =>
          clipId === 'b' ? clip('b', 2, [30]) : clip('a', 3, [50]),
        readSequenceDraft: async (characterId, draftId) => ({
          id: draftId,
          characterId,
          clips: ['a', 'b'],
          forkOf: null,
          spriteForgeVersion: '0.1.0',
          dir: `characters/${characterId}/sequence-drafts/${draftId}`,
        }),
        ...api,
      }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');
    wb.setMode('compose');
    wb.root.querySelector<HTMLElement>('[data-sequence-draft-open]')!.click();
    // The preview reads its sources from the render, so it settles a hop behind
    // the load that opened the composition.
    for (let hop = 0; hop < 5 && wb.previewSlots.length !== 2; hop += 1) {
      await wb.settled();
    }
    return wb;
  }

  function counter(wb: ReturnType<typeof mountWorkbench>): string {
    return wb.root.querySelector('[data-sequence-counter]')!.textContent ?? '';
  }

  /**
   * Let the preview finish whatever the last action started.
   *
   * A save re-renders, the render re-reads the slots, and that read is a hop behind
   * the save; awaiting `settled` once only covers the save.
   */
  async function settlePreview(
    wb: ReturnType<typeof mountWorkbench>,
    until: () => boolean,
  ): Promise<void> {
    for (let hop = 0; hop < 8 && !until(); hop += 1) {
      await wb.settled();
    }
  }

  it('plays both Clips in order, each at its own delay, across the seam', async () => {
    vi.useFakeTimers();
    const wb = await composing();
    expect(counter(wb)).toContain('a · 1/3');

    wb.root.querySelector<HTMLElement>('[data-sequence-play]')!.click();
    await wb.settled();
    // `a` has 3 frames at 50 ms: two ticks reach its last frame, still inside `a`.
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(50);
    expect(counter(wb)).toContain('a · 3/3');
    // The next tick crosses the seam, and `b` runs at its own 30 ms.
    vi.advanceTimersByTime(50);
    expect(counter(wb)).toContain('b · 1/2');
    // The last frame of `b` is the end of the strip.
    vi.advanceTimersByTime(30);
    expect(
      wb.root.querySelector<HTMLButtonElement>('[data-sequence-next]')!.disabled,
    ).toBe(true);
    vi.useRealTimers();
  });

  it('wraps from the last frame back to the first', async () => {
    vi.useFakeTimers();
    const wb = await composing();
    wb.root.querySelector<HTMLElement>('[data-sequence-play]')!.click();
    await wb.settled();
    // 3×50 + 2×30 = 210 ms runs the whole composition out.
    vi.advanceTimersByTime(210);
    expect(counter(wb)).toContain('a · 1/3');
    vi.useRealTimers();
  });

  it('marks the seam and stands on the frame before it', async () => {
    const wb = await composing();

    // One join between the two Clips, drawn as its own control.
    const seam = wb.root.querySelector<HTMLElement>('[data-sequence-seam="1"]')!;
    expect(seam).not.toBeNull();
    seam.click();
    await wb.settled();
    // The frame before the join is `a`'s last, so ▶ is the Clip change itself.
    expect(counter(wb)).toContain('a · 3/3');

    wb.root.querySelector<HTMLElement>('[data-sequence-next]')!.click();
    await wb.settled();
    expect(counter(wb)).toContain('b · 1/2');
  });

  it('jumps from the transport when the playhead is not near the seam', async () => {
    const wb = await composing();
    wb.root.querySelector<HTMLElement>('[data-sequence-seek="1"]')!.click();
    await wb.settled();
    expect(counter(wb)).toContain('b · 1/2');

    wb.root.querySelector<HTMLElement>('[data-sequence-seam-before]')!.click();
    await wb.settled();
    expect(counter(wb)).toContain('a · 3/3');
  });

  it('stands in for a Clip whose sheet cannot be read', async () => {
    const wb = await composing({
      readClip: async (_characterId, clipId) => {
        if (clipId === 'b') {
          throw new Error('broken provenance');
        }
        return clip('a', 3, [50]);
      },
    });

    wb.root.querySelector<HTMLElement>('[data-sequence-seek="1"]')!.click();
    await wb.settled();
    expect(wb.root.querySelector('[data-sequence-missing="b"]')).not.toBeNull();
    expect(wb.root.querySelector('[data-action-error]')).toBeNull();
  });

  it('clamps the playhead when the Clip under it is removed', async () => {
    const wb = await composing();
    wb.root.querySelector<HTMLElement>('[data-sequence-seek="1"]')!.click();
    await wb.settled();

    wb.root.querySelectorAll<HTMLElement>('[data-sequence-remove]')[1]!.click();
    await settlePreview(wb, () => wb.previewSlots.length === 1);
    expect(counter(wb)).toContain('a · 3/3');
  });

  it('forks a Clip to align it and puts its commit back in the slot', async () => {
    const forks: Array<{ clipId: string; draftId?: string }> = [];
    const saves: string[][] = [];
    const commits: string[] = [];
    const wb = await composing({
      forkClip: async (_characterId, clipId, draftId) => {
        forks.push({ clipId, ...(draftId === undefined ? {} : { draftId }) });
        return { ...DRAFT, id: draftId ?? 'fork' };
      },
      commitDraft: async (characterId, _draftId, name) => {
        commits.push(name);
        return { kind: 'clip', id: name, dir: `characters/${characterId}/clips/${name}` } as
          unknown as CommittedAsset;
      },
      saveSequenceDraft: async (characterId, request) => {
        saves.push(request.clips);
        return {
          id: request.draftId ?? 'composition',
          characterId,
          clips: [...request.clips],
          forkOf: request.forkOf ?? null,
          spriteForgeVersion: '0.1.0',
          dir: `characters/${characterId}/sequence-drafts/composition`,
        };
      },
    });

    wb.root.querySelectorAll<HTMLElement>('[data-sequence-align-row]')[1]!.click();
    await settlePreview(wb, () => wb.root.querySelector('[data-sequence-draft-frame]') !== null);

    expect(forks).toEqual([{ clipId: 'b', draftId: 'b-align' }]);
    // The composition stays on screen — the seam is the reason for the fork — and
    // the playhead is parked on the frame before it, so ▶ is the join itself.
    expect(wb.mode).toBe('compose');
    expect(wb.realign).toMatchObject({ slot: 1, clipId: 'b' });
    expect(counter(wb)).toContain('a · 3/3');
    // The slot plays the fork's own frame, not the still-placed committed Clip.
    expect(
      wb.root.querySelector('[data-sequence-draft-frame="b-align"]'),
    ).not.toBeNull();
    expect(wb.root.querySelector('[data-align-for-composition]')?.textContent).toContain(
      'b',
    );

    // Stepping forward is the Clip change; the fork's own first frame is what shows.
    wb.root.querySelector<HTMLElement>('[data-sequence-next]')!.click();
    await wb.settled();
    expect(counter(wb)).toContain('b · 1/3');

    // The commit is in the panel, and it takes the slot.
    wb.root.querySelector<HTMLElement>('[data-commit-run]')!.click();
    await settlePreview(wb, () =>
      [...wb.root.querySelectorAll<HTMLElement>('[data-sequence-clip]')].some(
        (item) => item.dataset.sequenceClip === 'b-align',
      ),
    );

    expect(commits).toEqual(['b-align']);
    // The slot took the new Clip rather than the composition pointing at the old.
    expect(saves.at(-1)).toEqual(['a', 'b-align']);
    expect(wb.mode).toBe('compose');
    expect(wb.realign).toBeNull();
    const items = wb.root.querySelectorAll<HTMLElement>('[data-sequence-clip]');
    expect([...items].map((item) => item.dataset.sequenceClip)).toEqual(['a', 'b-align']);
  });

  it('places the fork by its pending offset and mirror, and drops it on discard', async () => {
    let flip = false;
    const wb = await composing({
      forkClip: async (_characterId, _clipId, draftId) => ({ ...DRAFT, id: draftId ?? 'fork' }),
      setFlipX: async (_characterId, draftId, next) => {
        flip = next;
        return { ...DRAFT, id: draftId, flipX: next };
      },
      readCharacterAlignment: async () => ({
        ...ALIGNMENT,
        drafts: [{ id: 'b-align', placementOffset: { x: 3, y: -2 }, flipX: flip }],
      }),
      discardDraft: async () => undefined,
    });

    wb.root.querySelectorAll<HTMLElement>('[data-sequence-align-row]')[1]!.click();
    await settlePreview(wb, () => wb.root.querySelector('[data-sequence-draft-frame]') !== null);

    // The fork's pending placement is on the frame it is placed with, so the seam
    // can be judged against what the commit will bake.
    const frame = wb.root.querySelector<HTMLElement>('[data-sequence-draft-frame]')!;
    expect(frame.dataset.offsetX).toBe('3');
    expect(frame.dataset.offsetY).toBe('-2');
    expect(frame.dataset.flip).toBe('false');

    const mirror = wb.root.querySelector<HTMLInputElement>('[data-align-flip]')!;
    mirror.checked = true;
    mirror.dispatchEvent(new Event('change'));
    await settlePreview(
      wb,
      () => wb.root.querySelector<HTMLElement>('[data-sequence-draft-frame]')?.dataset.flip === 'true',
    );
    expect(wb.root.querySelector<HTMLElement>('[data-sequence-draft-frame]')!.dataset.flip).toBe(
      'true',
    );

    // Dropping the fork leaves the composition alone and puts the old Clip back.
    wb.root.querySelector<HTMLElement>('[data-discard-draft]')!.click();
    answerDialog();
    await settlePreview(wb, () => wb.realign === null);
    expect(wb.mode).toBe('compose');
    expect(wb.root.querySelector('[data-sequence-draft-frame]')).toBeNull();
    expect(counter(wb)).toContain('a · 3/3 · frame 3/5');
  });

  it('moves the adjustment to another Clip from the panel or its row', async () => {
    const forks: string[] = [];
    const dropped: string[] = [];
    const wb = await composing({
      forkClip: async (_characterId, clipId, draftId) => {
        forks.push(draftId ?? clipId);
        return { ...DRAFT, id: draftId ?? 'fork' };
      },
      discardDraft: async (_characterId, draftId) => {
        dropped.push(draftId);
      },
    });

    wb.root.querySelectorAll<HTMLElement>('[data-sequence-align-row]')[0]!.click();
    await settlePreview(wb, () => wb.realign !== null);
    expect(wb.realign).toMatchObject({ slot: 0, forkDraftId: 'a-align' });
    // The Clip in hand says so, and the other one offers the switch.
    expect(wb.root.querySelector<HTMLElement>('[data-align-target="0"]')!.dataset.active).toBe('');
    expect(wb.root.querySelector<HTMLElement>('[data-align-target="1"]')!.dataset.active).toBe(
      undefined,
    );

    // The panel retargets to the second Clip by itself.
    wb.root.querySelector<HTMLElement>('[data-align-target="1"]')!.click();
    await settlePreview(
      wb,
      () => wb.root.querySelector('[data-sequence-draft-frame="b-align"]') !== null,
    );

    expect(forks).toEqual(['a-align', 'b-align']);
    // The abandoned fork was never committed, so switching takes it back.
    expect(dropped).toEqual(['a-align']);
    expect(wb.realign).toMatchObject({ slot: 1, forkDraftId: 'b-align' });
    expect(wb.mode).toBe('compose');
    // The playhead is parked on the seam of the new one, and it is the clip whose
    // offset the panel edits.
    expect(counter(wb)).toContain('a · 3/3');
    expect(wb.root.querySelector('[data-sequence-draft-frame="b-align"]')).not.toBeNull();
    expect(wb.root.querySelector('[data-align-offset-y]')).not.toBeNull();

    // Pressing the Clip already in hand only walks back to its seam.
    wb.root.querySelector<HTMLElement>('[data-sequence-next]')!.click();
    await wb.settled();
    expect(counter(wb)).toContain('b · 1/3');
    wb.root.querySelectorAll<HTMLElement>('[data-sequence-align-row]')[1]!.click();
    await settlePreview(wb, () => counter(wb).includes('a · 3/3'));
    expect(dropped).toEqual(['a-align']);
    expect(forks).toEqual(['a-align', 'b-align']);
  });

  it('leaves an unrelated commit alone', async () => {
    const saves: string[][] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        saveSequenceDraft: async (characterId, request) => {
          saves.push(request.clips);
          return {
            id: request.draftId ?? 'composition',
            characterId,
            clips: [...request.clips],
            forkOf: request.forkOf ?? null,
            spriteForgeVersion: '0.1.0',
            dir: `characters/${characterId}/sequence-drafts/composition`,
          };
        },
      }),
    });
    await wb.ready;
    await openCharacter(wb, 'hero');
    // Open a composition, then go and commit a Draft that has nothing to do with it.
    wb.setMode('compose');
    wb.root.querySelector<HTMLElement>('[data-sequence-new]')!.click();
    await wb.settled();
    const savesBefore = saves.length;

    await openDraftForEdit(wb, 'hero', 'wip');
    wb.root.querySelector<HTMLElement>('[data-commit-run]')!.click();
    await wb.settled();

    expect(saves).toHaveLength(savesBefore);
    expect(wb.mode).toBe('view');
  });
});

describe('export contract fields', () => {
  it('sends the animation subset, situations, flips and facing', async () => {
    const requests: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        exportCharacter: async (_characterId, target, request) => {
          requests.push({ target, ...request });
          return EXPORT_RESULT;
        },
      }),
    });
    await wb.ready;
    await wb.loadCharacter('hero');
    wb.setMode('export');

    const stage = wb.root.querySelector('[data-region="stage"]')!;
    (stage.querySelector('[data-export-target-input]') as HTMLInputElement).value = 'pixel-pet';
    stage.querySelector<HTMLInputElement>('[data-export-animation="walk"]')!.click();
    stage.querySelector<HTMLInputElement>('[data-export-flip="walk"]')!.click();
    // The first Situation is there to fill; bind it, then declare a second one.
    typeInto(
      stage.querySelector<HTMLInputElement>('[data-export-situation-name]')!,
      'idle',
    );
    stage.querySelector<HTMLElement>('[data-export-situation-bind="walk"]')!.click();
    stage.querySelector<HTMLElement>('[data-export-situation-add]')!.click();
    typeInto(
      stage.querySelectorAll<HTMLInputElement>('[data-export-situation-name]')[1]!,
      'happy',
    );
    stage.querySelectorAll<HTMLElement>('[data-export-situation-bind="walk"]')[1]!.click();
    (stage.querySelector('[data-export-facing]') as HTMLSelectElement).value = 'left';
    stage.querySelector<HTMLFormElement>('[data-export-form]')!.requestSubmit();
    await wb.settled();

    expect(requests).toEqual([
      {
        target: 'pixel-pet',
        bindings: { idle: ['walk'], happy: ['walk'] },
        animations: ['walk'],
        situations: ['idle', 'happy'],
        flipsFacing: ['walk'],
        authoredFacing: 'left',
      },
    ]);
  });

  it('offers only the ticked animations as bindings', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadCharacter('hero');
    wb.setMode('export');

    const stage = wb.root.querySelector('[data-region="stage"]')!;
    const bindables = (): string[] =>
      [...stage.querySelectorAll<HTMLElement>('[data-export-situation-bind]')].map(
        (chip) => chip.dataset.exportSituationBind!,
      );
    // Nothing ticked: a row has nothing to bind to and says so.
    expect(bindables()).toEqual([]);
    expect(stage.textContent).toContain('tick an animation to bind it');

    stage.querySelector<HTMLInputElement>('[data-export-animation="walk"]')!.click();
    expect(bindables()).toEqual(['walk']);
  });

  it('keeps a binding whose animation was unticked, and blocks the export until it is back', async () => {
    const requests: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        exportCharacter: async (_characterId, target, request) => {
          requests.push({ target, ...request });
          return EXPORT_RESULT;
        },
      }),
    });
    await wb.ready;
    await wb.loadCharacter('hero');
    wb.setMode('export');

    const stage = wb.root.querySelector('[data-region="stage"]')!;
    (stage.querySelector('[data-export-target-input]') as HTMLInputElement).value = 'pixel-pet';
    stage.querySelector<HTMLInputElement>('[data-export-animation="walk"]')!.click();
    stage.querySelector<HTMLElement>('[data-export-situation-bind="walk"]')!.click();
    // Unticking leaves the reference in place (marked), rather than silently
    // binding a Situation to nothing.
    stage.querySelector<HTMLInputElement>('[data-export-animation="walk"]')!.click();
    const stale = stage.querySelector<HTMLElement>('[data-export-situation-bind="walk"][data-stale]');
    expect(stale).not.toBeNull();
    expect(stage.querySelector('[data-export-situation-problem]')?.textContent).toContain(
      'not exported',
    );

    stage.querySelector<HTMLFormElement>('[data-export-form]')!.requestSubmit();
    await wb.settled();
    expect(requests).toEqual([]);

    // Ticking it again clears the objection and the export goes through.
    stage.querySelector<HTMLInputElement>('[data-export-animation="walk"]')!.click();
    stage.querySelector<HTMLFormElement>('[data-export-form]')!.requestSubmit();
    await wb.settled();
    expect(requests).toHaveLength(1);
  });

  it('catches a duplicated or unbound Situation before the server sees it', async () => {
    const requests: unknown[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        exportCharacter: async (_characterId, target, request) => {
          requests.push({ target, ...request });
          return EXPORT_RESULT;
        },
      }),
    });
    await wb.ready;
    await wb.loadCharacter('hero');
    wb.setMode('export');

    const stage = wb.root.querySelector('[data-region="stage"]')!;
    (stage.querySelector('[data-export-target-input]') as HTMLInputElement).value = 'pixel-pet';
    stage.querySelector<HTMLInputElement>('[data-export-animation="walk"]')!.click();
    stage.querySelector<HTMLElement>('[data-export-situation-bind="walk"]')!.click();

    stage.querySelector<HTMLElement>('[data-export-situation-add]')!.click();
    typeInto(stage.querySelectorAll<HTMLInputElement>('[data-export-situation-name]')[1]!, 'idle');
    expect(stage.querySelector('[data-export-situation-problem]')?.textContent).toContain(
      'declared twice',
    );

    stage.querySelector<HTMLFormElement>('[data-export-form]')!.requestSubmit();
    await wb.settled();
    expect(requests).toEqual([]);
  });

  it('keeps the half-typed form across a re-render', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadCharacter('hero');
    wb.setMode('export');

    const stage = wb.root.querySelector('[data-region="stage"]')!;
    (stage.querySelector('[data-export-target-input]') as HTMLInputElement).value = 'pixel-pet';
    (stage.querySelector('[data-export-target-input]') as HTMLInputElement).dispatchEvent(
      new Event('input'),
    );
    // A re-render of the stage (a mode toggle away and back) must not wipe it.
    wb.setMode('align');
    wb.setMode('export');

    expect(
      (wb.root.querySelector('[data-export-target-input]') as HTMLInputElement).value,
    ).toBe('pixel-pet');
  });
});

describe('discard and store check', () => {
  it('discards a Draft and falls back to its Character', async () => {
    const discarded: string[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        discardDraft: async (characterId, draftId) => {
          discarded.push(`${characterId}/${draftId}`);
        },
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');

    wb.root.querySelector<HTMLElement>('[data-discard-draft]')!.click();
    answerDialog();
    await wb.settled();

    expect(discarded).toEqual(['hero/wip']);
    expect(wb.activeDraft).toBeNull();
    expect(wb.mode).toBe('align');
  });

  it('offers Discard on the Placement face too, where extraction lands', async () => {
    const discarded: string[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        discardDraft: async (characterId, draftId) => {
          discarded.push(`${characterId}/${draftId}`);
        },
      }),
    });
    await wb.ready;
    await openDraftForEdit(wb, 'hero', 'wip');
    // Extract opens a Draft on Placement, so the way out has to be reachable there
    // without first switching to the Clip face.
    wb.setMode('align');
    await wb.settled();

    const inspector = wb.root.querySelector('[data-region="inspector"]')!;
    inspector.querySelector<HTMLElement>('[data-discard-draft]')!.click();
    answerDialog();
    await wb.settled();

    expect(discarded).toEqual(['hero/wip']);
    expect(wb.activeDraft).toBeNull();
  });

  it('renders the store check problems', async () => {
    const wb = mountWorkbench(container, {
      api: fakeApi({
        validateStore: async () => ({
          ok: false,
          root: '/tmp/store',
          artifactCount: 0,
          problems: [
            { artifact: 'characters/hero/clips/walk/meta.json', path: '/frameCount', message: 'must be a positive integer' },
          ],
        }),
      }),
    });
    await wb.ready;

    wb.root.querySelector<HTMLElement>('[data-validate-run]')!.click();
    await wb.settled();

    const report = wb.root.querySelector('[data-validation-report]');
    expect(report?.getAttribute('data-validation-report')).toBe('false');
    expect(report?.textContent).toContain('must be a positive integer');
  });
});
