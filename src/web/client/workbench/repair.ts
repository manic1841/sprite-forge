/**
 * Repair gestures on the Clip-editor frame.
 *
 * A pointer gesture becomes a Repair *operation*; the store replays the script
 * and hands back the resulting state, which the client just shows. Nothing here
 * edits pixels — the server is the only thing that knows how a Repair is applied.
 */

import type { WorkbenchContext } from './context.js';
import { colorInput, labeled, make, scopeSelect, sizeInput } from './dom.js';
import type { RepairOperationInput, RepairTool, RepairWarning } from '../types.js';
import type { UiTool } from './state.js';

/** The frame range an edit targets: the current frame, or the whole Clip. */
export function targetFrames(ctx: WorkbenchContext): { start: number; end: number } {
  if (ctx.state.scope === 'clip') {
    return { start: 0, end: ctx.state.draftDescriptor?.frameCount ?? 0 };
  }
  return { start: ctx.state.draftFrame, end: ctx.state.draftFrame + 1 };
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

/** Attach painting / eyedropper gestures to a frame image. */
export function attachPainting(ctx: WorkbenchContext, img: HTMLImageElement): void {
  img.addEventListener('pointerdown', (event) => {
    const pointer = event as PointerEvent;
    const tool = ctx.state.tool;
    if (tool === 'eyedropper') {
      void ctx.run('Pick colour', () => pickColor(ctx, pointer, img));
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
      void ctx.run('Repair', () => commitGesture(ctx, tool, start, points));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/** The eyedropper: sample the current frame's pixel and make it the brush colour. */
async function pickColor(
  ctx: WorkbenchContext,
  event: PointerEvent,
  img: HTMLImageElement,
): Promise<void> {
  const draft = ctx.state.target;
  if (draft.kind !== 'draft') {
    return;
  }
  const [x, y] = pointerPixel(event, img);
  const color = await ctx.api.sampleRepairColor(
    draft.characterId,
    draft.draftId,
    ctx.state.draftFrame,
    x,
    y,
  );
  ctx.state.brushColor = color;
  // Painting with the picked colour patches; switch to the brush so the next
  // gesture paints rather than sampling again.
  ctx.state.tool = 'paint';
  ctx.renderInspector();
}

/** Turn a gesture into a Repair operation and append it through the API. */
async function commitGesture(
  ctx: WorkbenchContext,
  tool: Exclude<UiTool, 'eyedropper'>,
  start: [number, number],
  points: Array<[number, number]>,
): Promise<void> {
  const target = ctx.state.target;
  if (target.kind !== 'draft') {
    return;
  }
  const { state } = ctx;
  const frames = targetFrames(ctx);
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
      geometry: { points, size: state.brushSize },
      ...(tool === 'paint' ? { color: state.brushColor } : {}),
    };
  }
  state.repair = await ctx.api.appendRepairOperation(
    target.characterId,
    target.draftId,
    operation,
  );
  state.repairRevision += 1;
  ctx.renderStage();
  ctx.renderContext();
  ctx.renderInspector();
}

/** Drop the last Repair operation. */
export async function undoRepair(ctx: WorkbenchContext): Promise<void> {
  const target = ctx.state.target;
  if (target.kind !== 'draft') {
    return;
  }
  ctx.state.repair = await ctx.api.undoRepairOperation(target.characterId, target.draftId);
  ctx.state.repairRevision += 1;
  ctx.renderStage();
  ctx.renderInspector();
}

/** A Repair-validity warning row (`[data-repair-warning="<code>"]`). */
export function warningRow(warning: RepairWarning): HTMLElement {
  const row = make('p', 'repair-warning', warning.message);
  row.setAttribute('data-repair-warning', warning.code);
  return row;
}

/**
 * The Repair tools, as a bar under the frame they paint on.
 *
 * Tools sit with the canvas rather than in the inspector: the eye is on the
 * pixels while a tool is chosen, so putting the picker on the far side of the
 * screen is a round trip for every stroke. The inspector keeps the log.
 */
export function repairBar(ctx: WorkbenchContext): HTMLElement {
  const { state } = ctx;
  const bar = make('div', 'repair-bar');
  bar.dataset.repairBar = '';

  const tools = make('div', 'repair-tools');
  const toolButton = (tool: UiTool, label: string): void => {
    const button = make('button', 'btn small', label);
    button.dataset.repairTool = tool;
    button.classList.toggle('on', state.tool === tool);
    button.setAttribute('aria-pressed', String(state.tool === tool));
    button.addEventListener('click', () => {
      state.tool = tool;
      ctx.renderStage();
    });
    tools.appendChild(button);
  };
  toolButton('paint', 'Brush');
  toolButton('erase', 'Eraser');
  toolButton('rect', 'Rect');
  toolButton('eyedropper', 'Eyedropper');
  bar.appendChild(tools);

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
  bar.appendChild(settings);

  const undo = make('button', 'btn small', 'Undo') as HTMLButtonElement;
  undo.dataset.repairUndo = '';
  undo.disabled = (state.repair?.operations.length ?? 0) === 0;
  undo.addEventListener('click', () => void ctx.run('Undo repair', () => undoRepair(ctx)));
  bar.appendChild(undo);

  return bar;
}

/** The Repair log: validity warnings, then the replayed operations, newest last. */
export function repairLog(ctx: WorkbenchContext): HTMLElement {
  const log = make('div', 'repair-log');
  log.dataset.repairLog = '';

  for (const warning of ctx.state.repair?.warnings ?? []) {
    log.appendChild(warningRow(warning));
  }

  const list = make('ol', 'repair-ops');
  list.dataset.repairOps = '';
  const operations = ctx.state.repair?.operations ?? [];
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
  log.appendChild(list);

  return log;
}
