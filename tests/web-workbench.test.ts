// @vitest-environment jsdom
//
// DOM-level smoke tests for the workbench shell. They pin the **structural
// contract** later tickets depend on: the four persistent regions, the mode
// switch that swaps the stage while the other regions keep their node identity,
// the Library list derived from a store scan, the filmstrip's frame cells + cut
// ranges, and — from #26 — the Clip editor stage showing a Draft's frames with a
// contextual inspector. Behaviour that cannot be pinned structurally (dragging a
// range edge, real painting) is verified by running `pnpm web` against a temp store.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountWorkbench, slugifyId } from '../src/web/client/app.js';
import { clampRange } from '../src/web/client/timeline.js';
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
    addSegment: async () => CUTS,
    setSegmentRange: async () => CUTS,
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
    expandCanvas: async () => ({
      canvas: ALIGNMENT.canvas,
      rebakedClips: [],
      rebakedSequences: [],
      repairWarnings: [],
    }),
    sheetUrl: (characterId, kind, id) =>
      `/api/characters/${characterId}/${kind === 'clip' ? 'clips' : 'sequences'}/${id}/sheet`,
    exportCharacter: async () => EXPORT_RESULT,
    readManifest: async () => EXPORT_RESULT,
    readClip: async () => CLIP,
    readSequence: async () => SEQUENCE,
    forkClip: async () => DRAFT,
    forkSequence: async () => SEQUENCE_FORK,
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
};const EMPTY_ALIGNMENT: AlignmentState = { offset: { x: 0, y: 0 }, warnings: [] };
const ALIGNMENT: CharacterAlignment = {
  canvas: { width: 4, height: 6, anchor: { x: 2, y: 6 } },
  clips: [{ id: 'walk', placementOffset: { x: 0, y: -1 } }],
  drafts: [{ id: 'wip' }],
};

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  // jsdom leaves confirm()/prompt() unimplemented; without a stub every
  // confirmation resolves falsy and the action silently never runs.
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'prompt').mockReturnValue(null);
});

describe('the workbench shell', () => {
  it('renders the four persistent regions', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    expect(wb.root.querySelector('[data-region="rail"]')).not.toBeNull();
    expect(wb.root.querySelector('[data-region="stage"]')).not.toBeNull();
    expect(wb.root.querySelector('[data-region="inspector"]')).not.toBeNull();
    expect(wb.root.querySelector('[data-region="filmstrip"]')).not.toBeNull();
  });

  it('swaps the stage and contextually re-renders the inspector when the mode changes', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    const rail = wb.root.querySelector('[data-region="rail"]');
    const inspector = wb.root.querySelector('[data-region="inspector"]');
    const filmstrip = wb.root.querySelector('[data-region="filmstrip"]');
    const stage = wb.root.querySelector('[data-region="stage"]');
    const railHtml = rail!.innerHTML;
    const filmstripHtml = filmstrip!.innerHTML;

    expect(wb.mode).toBe('clip');
    expect(stage!.querySelector('[data-stage-view="clip-editor"]')).not.toBeNull();
    expect((inspector as HTMLElement).dataset.inspectorFor).toBe('clip');

    wb.root.querySelector<HTMLElement>('[data-mode="export"]')!.click();

    // The stage is the region whose committed view swaps.
    expect(wb.mode).toBe('export');
    expect(stage!.querySelector('[data-stage-view="export"]')).not.toBeNull();
    expect(stage!.querySelector('[data-stage-view="clip-editor"]')).toBeNull();

    // Every region persists as a node; rail and filmstrip are never touched.
    expect(wb.root.querySelector('[data-region="rail"]')).toBe(rail);
    expect(wb.root.querySelector('[data-region="inspector"]')).toBe(inspector);
    expect(wb.root.querySelector('[data-region="filmstrip"]')).toBe(filmstrip);
    expect(rail!.innerHTML).toBe(railHtml);
    expect(filmstrip!.innerHTML).toBe(filmstripHtml);

    // The inspector region persists, but its content is contextual to the mode.
    expect((inspector as HTMLElement).dataset.inspectorFor).toBe('export');
  });
});

describe('the Library', () => {
  it('lists Recordings and committed Assets from the store scan', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    const rail = wb.root.querySelector('[data-region="rail"]')!;
    const recordings = [...rail.querySelectorAll('[data-recording]')].map(
      (el) => (el as HTMLElement).dataset.recording,
    );
    const assets = [...rail.querySelectorAll('[data-asset]')].map((el) => ({
      id: (el as HTMLElement).dataset.asset,
      kind: (el as HTMLElement).dataset.assetKind,
    }));

    expect(recordings).toEqual(['idle', 'fat-walk']);
    expect(assets).toEqual([
      { id: 'walk', kind: 'clip' },
      { id: 'greeting', kind: 'sequence' },
    ]);
  });

  it('makes a Recording the active item when it is clicked', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    wb.root.querySelector<HTMLElement>('[data-recording="fat-walk"]')!.click();
    await wb.settled();

    expect(wb.activeRecording).toBe('fat-walk');
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
    // Each range exposes edges to drag, wired to the core-backed API.
    expect(wb.root.querySelectorAll('[data-region="filmstrip"] [data-cut-handle]')).toHaveLength(4);
  });
});

describe('the Clip editor stage', () => {
  it('lists Drafts in the Library and makes one active on click', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    const draftItems = wb.root.querySelectorAll('[data-region="rail"] [data-draft]');
    expect([...draftItems].map((el) => (el as HTMLElement).dataset.draft)).toEqual(['wip']);

    wb.root.querySelector<HTMLElement>('[data-draft="wip"]')!.click();
    await wb.settled();

    expect(wb.activeDraft).toEqual({ characterId: 'hero', draftId: 'wip' });
  });

  it("renders a Draft's frames frame-by-frame when it is active", async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadDraft('hero', 'wip');

    const view = wb.root.querySelector('[data-stage-view="clip-editor"]')!;
    const img = view.querySelector<HTMLImageElement>('[data-draft-frame]')!;
    expect(img.getAttribute('src')).toBe('/api/characters/hero/drafts/wip/frames/0');
    expect(view.querySelector('[data-draft-frame-counter]')!.textContent).toBe('frame 0 / 3');
    expect(view.querySelectorAll('[data-draft-frame-cell]')).toHaveLength(3);
    expect(wb.activeDraftFrame).toBe(0);
  });

  it('navigates Draft frames by frame index (the unit)', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadDraft('hero', 'wip');

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

  it('renders the contextual Clip-editor inspector with per-frame info and a Repair slot', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadDraft('hero', 'wip');

    const inspector = wb.root.querySelector('[data-region="inspector"]') as HTMLElement;
    expect(inspector.dataset.inspectorFor).toBe('clip');
    const draftSection = inspector.querySelector('[data-inspector-section="draft"]');
    expect(draftSection).not.toBeNull();
    // Per-frame facts, not just the Draft as a whole.
    const keys = [...draftSection!.querySelectorAll('dt')].map((el) => el.textContent);
    expect(keys).toEqual(
      expect.arrayContaining(['character', 'draft', 'recording', 'frames', 'frame', 'delay']),
    );
    // The slot #27 extends (brush colour/size + operation list).
    expect(
      inspector.querySelector('[data-inspector-section="repair"] [data-repair-controls]'),
    ).not.toBeNull();
  });

  it('keeps the active Draft when the mode changes, swapping only the stage', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadDraft('hero', 'wip');

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
  it('renders the brush, eyedropper, scope, undo and operation list in the slot', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadDraft('hero', 'wip');

    const controls = wb.root.querySelector(
      '[data-inspector-section="repair"] [data-repair-controls]',
    )!;
    expect(controls).not.toBeNull();
    expect(controls.querySelector('[data-repair-tool="paint"]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-tool="erase"]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-tool="rect"]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-tool="eyedropper"]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-color]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-size]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-scope]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-undo]')).not.toBeNull();
    expect(controls.querySelector('[data-repair-ops]')).not.toBeNull();
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
    await wb.loadDraft('hero', 'wip');

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
    await wb.loadDraft('hero', 'wip');

    expect(
      wb.root.querySelector('[data-repair-warning="framing-changed"]'),
    ).not.toBeNull();
  });
});

describe('the Alignment stage', () => {
  it('ghosts Clips on the shared Canvas against the Anchor', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    wb.setMode('align');
    await wb.settled();

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

  it('shows per-Clip offsets and an explicit expand-canvas action in the inspector', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await wb.loadDraft('hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    const inspector = wb.root.querySelector('[data-region="inspector"]') as HTMLElement;
    expect(inspector.dataset.inspectorFor).toBe('align');
    expect(inspector.querySelector('[data-inspector-section="alignment"]')).not.toBeNull();
    // Per-Clip offsets (the committed Clip is read-only; the Draft is editable).
    expect(inspector.querySelector('[data-align-clip-offset="walk"]')).not.toBeNull();
    expect(inspector.querySelector('[data-align-offset-x]')).not.toBeNull();
    expect(inspector.querySelector('[data-align-offset-y]')).not.toBeNull();
    // The explicit Character-wide expand action exists.
    expect(inspector.querySelector('[data-expand-canvas-action]')).not.toBeNull();
    expect(inspector.querySelector('[data-expand-width]')).not.toBeNull();
    expect(inspector.querySelector('[data-expand-height]')).not.toBeNull();
  });

  it('surfaces a stale-alignment warning from the server rather than hiding it', async () => {
    const warned = fakeApi({
      readDraftAlignment: async () => ({
        offset: { x: 0, y: -1 },
        warnings: [{ code: 'alignment-framing-changed', message: 'the Canvas changed' }],
      }),
    });
    const wb = mountWorkbench(container, { api: warned });
    await wb.ready;
    await wb.loadDraft('hero', 'wip');
    wb.setMode('align');
    await wb.settled();

    expect(
      wb.root.querySelector('[data-alignment-warning="alignment-framing-changed"]'),
    ).not.toBeNull();
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

    const rail = wb.root.querySelector('[data-region="rail"]')!;
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

    const rail = wb.root.querySelector('[data-region="rail"]')!;
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

    const rail = wb.root.querySelector('[data-region="rail"]')!;
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

    const rail = wb.root.querySelector('[data-region="rail"]')!;
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

    const rail = wb.root.querySelector('[data-region="rail"]')!;
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

  it('adds, renames and deletes segments from the stage', async () => {
    const added: unknown[] = [];
    const removed: string[] = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        addSegment: async (_id, segment) => {
          added.push(segment);
          return CUTS;
        },
        removeSegment: async (_id, cutId) => {
          removed.push(cutId);
          return CUTS;
        },
      }),
    });
    await wb.ready;
    await wb.loadRecording('idle');

    const stage = wb.root.querySelector('[data-region="stage"]')!;
    (stage.querySelector('[data-segment-id]') as HTMLInputElement).value = 'jump';
    (stage.querySelector('[data-segment-start]') as HTMLInputElement).value = '2';
    (stage.querySelector('[data-segment-end]') as HTMLInputElement).value = '5';
    (stage.querySelector('[data-segment-add]') as HTMLFormElement).requestSubmit();
    await wb.settled();

    expect(added).toEqual([{ id: 'jump', startFrame: 2, endFrame: 5 }]);

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    stage.querySelector<HTMLElement>('[data-segment-delete="walk"]')!.click();
    await wb.settled();
    expect(removed).toEqual(['walk']);
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
    const stage = wb.root.querySelector('[data-region="stage"]')!;
    stage.querySelector<HTMLElement>('[data-segment-delete="walk"]')!.click();
    await wb.settled();
    expect(removed).toEqual([]);
  });

  it('renames a segment through the prompt', async () => {
    const renamed: string[] = [];
    vi.spyOn(window, 'prompt').mockReturnValue('stride');
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

    wb.root.querySelector<HTMLElement>('[data-segment-rename="walk"]')!.click();
    await wb.settled();
    expect(renamed).toEqual(['walk->stride']);
  });

  it('creates a Character from the derived framing', async () => {
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
    await wb.loadRecording('idle');

    const stage = wb.root.querySelector('[data-region="stage"]')!;
    (stage.querySelector('[data-character-id]') as HTMLInputElement).value = 'hero';
    (stage.querySelector('[data-character-add]') as HTMLFormElement).requestSubmit();
    await wb.settled();

    // The Canvas is explicit: it comes from the derived Anchor, not from later.
    expect(created).toEqual([
      { id: 'hero', canvas: { width: 4, height: 6, anchorX: 2, anchorY: 6 } },
    ]);
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

    wb.root.querySelector<HTMLElement>('[data-segment-extract="walk"]')!.click();
    await wb.settled();

    expect(extracted).toEqual([{ characterId: 'hero', recordingId: 'idle', cutId: 'walk' }]);
    // The new Draft is open, so repair can start without leaving the stage.
    expect(wb.activeDraft).toEqual({ characterId: 'hero', draftId: 'wip' });
    expect(wb.root.querySelector('[data-draft-frame]')).not.toBeNull();
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
    await wb.loadDraft('hero', 'wip');

    const inspector = wb.root.querySelector('[data-region="inspector"]')!;
    (inspector.querySelector('[data-commit-name]') as HTMLInputElement).value = 'walk';
    inspector.querySelector<HTMLElement>('[data-commit-run]')!.click();
    await wb.settled();

    expect(committed).toEqual(['hero/wip->walk']);
    // Committing consumes the Draft, so the workspace shows the new Clip playing.
    expect(wb.mode).toBe('clip');
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

    wb.root.querySelector<HTMLElement>('[data-asset="walk"]')!.click();
    await wb.settled();

    // An asset is immutable, so opening one lands on a read-only playback face.
    expect(wb.mode).toBe('clip');
    expect(sheets).toEqual(['hero/clip/walk']);
    const frame = wb.root.querySelector<HTMLElement>('[data-asset-frame]');
    expect(frame?.dataset.assetFrame).toBe('0');
    expect(wb.root.querySelector('[data-inspector-section="asset"]')).not.toBeNull();
  });

  it('steps the playback through the sheet without leaving the Asset', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    await (wb as unknown as { loadAsset: typeof wb.loadAlignment }) &&
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
    wb.root.querySelector<HTMLElement>('[data-asset="walk"]')!.click();
    await wb.settled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wb.root.querySelector<HTMLElement>('[data-asset-delete]')!.click();
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
    wb.root.querySelector<HTMLElement>('[data-asset="walk"]')!.click();
    await wb.settled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wb.root.querySelector<HTMLElement>('[data-asset-delete]')!.click();
    await wb.settled();

    expect(wb.root.querySelector('[data-action-error]')?.textContent).toContain('greeting');
    // The Asset is still open: a refused edit is not a lost load.
    expect(wb.root.querySelector('[data-asset-frame]')).not.toBeNull();
  });
});

describe('sequence composition', () => {
  it('forks the Clip list into an editable composition', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    wb.root.querySelector<HTMLElement>('[data-asset="greeting"]')!.click();
    await wb.settled();

    wb.root.querySelector<HTMLElement>('[data-sequence-edit]')!.click();
    await wb.settled();

    const items = wb.root.querySelectorAll<HTMLElement>('[data-sequence-clip]');
    expect([...items].map((item) => item.dataset.sequenceClip)).toEqual(['walk', 'greeting']);
  });

  it('reorders and commits the composition', async () => {
    const commits: Array<{ name: string; clips: string[] }> = [];
    const wb = mountWorkbench(container, {
      api: fakeApi({
        commitSequence: async (_characterId, sequenceId, clips) => {
          commits.push({ name: sequenceId, clips });
          return { ...SEQUENCE, id: sequenceId, provenance: { ...SEQUENCE.provenance, clips } };
        },
      }),
    });
    await wb.ready;
    wb.root.querySelector<HTMLElement>('[data-asset="greeting"]')!.click();
    await wb.settled();
    wb.root.querySelector<HTMLElement>('[data-sequence-edit]')!.click();
    await wb.settled();

    // The second entry moves up, so the committed order is reversed.
    const items = wb.root.querySelectorAll<HTMLElement>('[data-sequence-item], [data-sequence-clip]');
    expect(items.length).toBeGreaterThan(0);
    wb.root.querySelectorAll<HTMLElement>('[data-sequence-up]')[1]!.click();
    await wb.settled();

    (wb.root.querySelector('[data-sequence-name]') as HTMLInputElement).value = 'greet-walk';
    wb.root.querySelector<HTMLInputElement>('[data-sequence-name]')!.dispatchEvent(
      new Event('change'),
    );
    wb.root.querySelector<HTMLElement>('[data-sequence-commit]')!.click();
    await wb.settled();

    expect(commits).toEqual([{ name: 'greet-walk', clips: ['greeting', 'walk'] }]);
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
    wb.setMode('export');

    const stage = wb.root.querySelector('[data-region="stage"]')!;
    (stage.querySelector('[data-export-target-input]') as HTMLInputElement).value = 'pixel-pet';
    stage.querySelector<HTMLInputElement>('[data-export-animation="walk"]')!.click();
    stage.querySelector<HTMLInputElement>('[data-export-flip="walk"]')!.click();
    (stage.querySelector('[data-export-situations]') as HTMLInputElement).value = 'idle, happy';
    (stage.querySelector('[data-export-facing]') as HTMLSelectElement).value = 'left';
    stage.querySelector<HTMLFormElement>('[data-export-form]')!.requestSubmit();
    await wb.settled();

    expect(requests).toEqual([
      {
        target: 'pixel-pet',
        bindings: { idle: [] },
        animations: ['walk'],
        situations: ['idle', 'happy'],
        flipsFacing: ['walk'],
        authoredFacing: 'left',
      },
    ]);
  });

  it('keeps the half-typed form across a re-render', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;
    wb.setMode('export');

    const stage = wb.root.querySelector('[data-region="stage"]')!;
    (stage.querySelector('[data-export-target-input]') as HTMLInputElement).value = 'pixel-pet';
    (stage.querySelector('[data-export-target-input]') as HTMLInputElement).dispatchEvent(
      new Event('input'),
    );
    // A re-render of the stage (a mode toggle away and back) must not wipe it.
    wb.setMode('clip');
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
    await wb.loadDraft('hero', 'wip');

    wb.root.querySelector<HTMLElement>('[data-discard-draft]')!.click();
    await wb.settled();

    expect(discarded).toEqual(['hero/wip']);
    expect(wb.activeDraft).toBeNull();
    expect(wb.mode).toBe('align');
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
