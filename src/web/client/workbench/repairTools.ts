/**
 * Repair gestures on the Draft frame.
 *
 * A pointer gesture becomes a Repair *operation*; the store replays the script
 * and hands back the resulting state, which the client just shows. Nothing here
 * edits pixels — the server is the only thing that knows how a Repair is applied.
 *
 * The footprint overlay is the one visual exception: it is drawn in the frame's
 * own pixel coordinates so the operator can see the square that will be written.
 */

import type { WorkbenchApi } from '../api.js';
import type { RepairOperationInput, RepairTool } from '../types.js';
import type { WorkbenchState } from './state.js';

/** The frame range an edit targets: the current frame, or the whole Clip. */
export function targetFrames(state: WorkbenchState): { start: number; end: number } {
  if (state.scope === 'clip') {
    return { start: 0, end: state.draftDescriptor?.frameCount ?? 0 };
  }
  return { start: state.draftFrame, end: state.draftFrame + 1 };
}

/** What a gesture needs of the shell. */
export interface RepairDeps {
  readonly api: WorkbenchApi;
  readonly state: WorkbenchState;
  readonly regions: { stage: HTMLElement };
  readonly run: (label: string, body: () => Promise<void>) => void;
  renderStage(): void;
  renderInspector(): void;
  renderContext(): void;
}

/** The pixel under a pointer event, in Canvas coordinates (the frame PNG is the Canvas). */
function pointerPixel(event: PointerEvent, img: HTMLImageElement): [number, number] {
  const rect = img.getBoundingClientRect();
  const width = img.naturalWidth || rect.width || 1;
  const height = img.naturalHeight || rect.height || 1;
  const x = Math.floor(((event.clientX - rect.left) / (rect.width || 1)) * width);
  const y = Math.floor(((event.clientY - rect.top) / (rect.height || 1)) * height);
  return [x, y];
}

/**
 * The brush footprint and the pixel readout.
 *
 * The frame is usually shown smaller than its own pixels, so without this an
 * operator is aiming at a grid they cannot see. The overlay is a canvas at the
 * frame's **own** resolution stretched over it, which makes one canvas pixel
 * exactly one image pixel: the square under the cursor is the square that will be
 * written, at whatever size the brush is set to.
 */
export function attachFootprint(
  deps: RepairDeps,
  img: HTMLImageElement,
  overlay: HTMLCanvasElement,
): void {
  const paint = (event: PointerEvent): void => {
    const width = img.naturalWidth || 0;
    const height = img.naturalHeight || 0;
    if (width === 0 || height === 0) {
      return;
    }
    const pencil = deps.state.tool === 'eyedropper';
    const size = pencil ? 1 : deps.state.brushSize;
    const [x, y] = pointerPixel(event, img);

    overlay.width = width;
    overlay.height = height;
    const pen = overlay.getContext('2d');
    if (!pen) {
      return;
    }
    pen.clearRect(0, 0, width, height);
    pen.imageSmoothingEnabled = false;

    // Same centring as `stamp()` on the server, so the box is where the ink goes.
    const half = Math.floor((size - 1) / 2);
    pen.fillStyle = pencil ? 'rgba(255, 255, 255, 0.55)' : `${deps.state.brushColor}66`;
    pen.strokeStyle = pencil ? '#ffffff' : deps.state.brushColor;
    pen.lineWidth = 1;
    pen.fillRect(x - half, y - half, size, size);
    pen.strokeRect(x - half + 0.5, y - half + 0.5, size - 1, size - 1);

    const readout = deps.regions.stage.querySelector<HTMLElement>('[data-draft-cursor]');
    if (readout) {
      readout.textContent = `${x}, ${y}`;
    }
  };

  const clear = (): void => {
    const pen = overlay.getContext('2d');
    pen?.clearRect(0, 0, overlay.width, overlay.height);
    const readout = deps.regions.stage.querySelector<HTMLElement>('[data-draft-cursor]');
    if (readout) {
      readout.textContent = '—';
    }
  };

  img.addEventListener('pointermove', paint);
  img.addEventListener('pointerleave', clear);
}

/** Attach painting / eyedropper gestures to a frame image. */
export function attachPainting(deps: RepairDeps, img: HTMLImageElement): void {
  img.addEventListener('pointerdown', (event) => {
    const pointer = event as PointerEvent;
    const tool = deps.state.tool;
    if (tool === 'eyedropper') {
      deps.run('Pick colour', () => pickColor(deps, pointer, img));
      return;
    }
    event.preventDefault();
    const start = pointerPixel(pointer, img);
    const points: Array<[number, number]> = [start];
    const move = (moveEvent: PointerEvent): void => {
      const point = pointerPixel(moveEvent, img);
      const last = points[points.length - 1]!;
      if (point[0] !== last[0] || point[1] !== last[1]) {
        points.push(point);
      }
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      deps.run('Repair', () => commitGesture(deps, tool, start, points));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/** The eyedropper: sample the current frame's pixel and make it the brush colour. */
async function pickColor(
  deps: RepairDeps,
  event: PointerEvent,
  img: HTMLImageElement,
): Promise<void> {
  const draft = deps.state.target;
  if (draft.kind !== 'draft') {
    return;
  }
  const [x, y] = pointerPixel(event, img);
  const color = await deps.api.sampleRepairColor(
    draft.characterId,
    draft.draftId,
    deps.state.draftFrame,
    x,
    y,
  );
  deps.state.brushColor = color;
  // Painting with the picked colour patches; switch to the brush so the next
  // gesture paints rather than sampling again.
  deps.state.tool = 'paint';
  deps.renderInspector();
}

/** Turn a gesture into a Repair operation and append it through the API. */
async function commitGesture(
  deps: RepairDeps,
  tool: Exclude<WorkbenchState['tool'], 'eyedropper'>,
  start: [number, number],
  points: Array<[number, number]>,
): Promise<void> {
  const target = deps.state.target;
  if (target.kind !== 'draft') {
    return;
  }
  const frames = targetFrames(deps.state);
  let operation: RepairOperationInput;
  if (tool === 'rect') {
    const end = points[points.length - 1] ?? start;
    const x = Math.min(start[0], end[0]);
    const y = Math.min(start[1], end[1]);
    operation = {
      tool: 'erase-rect',
      frames,
      geometry: {
        x,
        y,
        width: Math.abs(end[0] - start[0]) + 1,
        height: Math.abs(end[1] - start[1]) + 1,
      },
    };
  } else {
    const brushTool: RepairTool = tool === 'paint' ? 'paint-brush' : 'erase-brush';
    operation = {
      tool: brushTool,
      frames,
      geometry: { points, size: deps.state.brushSize },
      ...(tool === 'paint' ? { color: deps.state.brushColor } : {}),
    };
  }
  deps.state.repair = await deps.api.appendRepairOperation(
    target.characterId,
    target.draftId,
    operation,
  );
  deps.state.repairRevision += 1;
  deps.renderStage();
  deps.renderContext();
  deps.renderInspector();
}

/** Drop the last Repair operation. */
export async function undoRepair(deps: RepairDeps): Promise<void> {
  const target = deps.state.target;
  if (target.kind !== 'draft') {
    return;
  }
  deps.state.repair = await deps.api.undoRepairOperation(target.characterId, target.draftId);
  deps.state.repairRevision += 1;
  deps.renderStage();
  deps.renderInspector();
}
