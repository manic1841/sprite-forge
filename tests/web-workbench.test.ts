// @vitest-environment jsdom
//
// DOM-level smoke tests for the workbench shell. They pin the **structural
// contract** later tickets depend on: the four persistent regions, the mode
// switch that swaps only the stage, the Library list derived from a store scan,
// and the filmstrip's frame cells + cut ranges from a cut list. Behaviour that
// cannot be pinned structurally (dragging a range edge, real painting) is
// verified by running `pnpm web` against a temp store.

import { beforeEach, describe, expect, it } from 'vitest';
import { clampRange, mountWorkbench } from '../src/web/client/app.js';
import type { WorkbenchApi } from '../src/web/client/api.js';
import type { CutList, StoreScan } from '../src/web/client/types.js';

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

/** A stub API standing in for the HTTP boundary; the UI only ever talks to this. */
function fakeApi(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  return {
    scan: async () => SCAN,
    readCutList: async () => CUTS,
    addSegment: async () => CUTS,
    setSegmentRange: async () => CUTS,
    removeSegment: async () => CUTS,
    ...overrides,
  };
}

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
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

  it('swaps only the stage when the mode changes', async () => {
    const wb = mountWorkbench(container, { api: fakeApi() });
    await wb.ready;

    const rail = wb.root.querySelector('[data-region="rail"]');
    const inspector = wb.root.querySelector('[data-region="inspector"]');
    const filmstrip = wb.root.querySelector('[data-region="filmstrip"]');
    const stage = wb.root.querySelector('[data-region="stage"]');
    const railHtml = rail!.innerHTML;
    const inspectorHtml = inspector!.innerHTML;
    const filmstripHtml = filmstrip!.innerHTML;

    expect(wb.mode).toBe('clip');
    expect(stage!.querySelector('[data-stage-view="clip-editor"]')).not.toBeNull();

    wb.root.querySelector<HTMLElement>('[data-mode="export"]')!.click();

    // Only the stage changed.
    expect(wb.mode).toBe('export');
    expect(stage!.querySelector('[data-stage-view="export"]')).not.toBeNull();
    expect(stage!.querySelector('[data-stage-view="clip-editor"]')).toBeNull();

    // The other regions keep both their node identity and their content.
    expect(wb.root.querySelector('[data-region="rail"]')).toBe(rail);
    expect(wb.root.querySelector('[data-region="inspector"]')).toBe(inspector);
    expect(wb.root.querySelector('[data-region="filmstrip"]')).toBe(filmstrip);
    expect(rail!.innerHTML).toBe(railHtml);
    expect(inspector!.innerHTML).toBe(inspectorHtml);
    expect(filmstrip!.innerHTML).toBe(filmstripHtml);
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
