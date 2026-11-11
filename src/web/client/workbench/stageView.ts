/**
 * The **View** stage: a committed Asset, played back.
 *
 * A committed Asset is immutable (ADR-0002), so this face only shows it — the
 * baked sheet, one frame at a time. Editing starts from here but happens on a
 * fork, hence the View/Clip split. Composition is not here either: it belongs to
 * the Character (`./stageCompose.ts`).
 */

import type { BasePort } from './ports.js';
import { make } from './dom.js';
import { activeAsset } from './state.js';

/** Render a committed Asset's playback, or the empty state. */
export function assetStageView(ctx: BasePort): HTMLElement {
  const view = make('div', 'stage-view');
  view.dataset.stageView = 'asset-view';

  const asset = ctx.state.asset;
  const target = activeAsset(ctx.state);
  if (!asset || !target) {
    view.dataset.emptyState = 'asset-view';
    view.appendChild(make('p', 'muted', 'Select an asset in the Library to view it.'));
    return view;
  }

  view.appendChild(playback(ctx, target.characterId, target.assetKind, target.assetId, asset.meta));
  return view;
}

/** How far a small frame is blown up on the view, in screen px per sheet px. */
const VIEW_SCALE_MAX = 16;

/** Play a baked sheet by stepping its own frames. */
function playback(
  ctx: BasePort,
  characterId: string,
  kind: 'clip' | 'sequence',
  assetId: string,
  meta: { frameCount: number },
): HTMLElement {
  const wrap = make('div', 'recording-viewer');
  wrap.dataset.assetViewer = '';
  wrap.dataset.assetFrameCount = String(meta.frameCount);

  const box = make('div', 'sheet-box');
  const img = document.createElement('img');
  img.className = 'sheet';
  img.dataset.assetFrame = String(ctx.state.assetFrame);
  img.src = ctx.api.sheetUrl(characterId, kind, assetId);
  img.alt = `baked sheet, frame ${ctx.state.assetFrame}`;
  // The sheet is one strip; the frame is a crop. Sizing the strip to
  // `frameCount × 100%` and sliding it left by one frame keeps the aspect ratio
  // and needs no request per frame.
  img.style.width = `${meta.frameCount * 100}%`;
  img.style.transform = `translateX(${(-ctx.state.assetFrame * 100) / meta.frameCount}%)`;
  box.appendChild(img);
  fitAssetFrame(ctx, box, img, meta.frameCount);

  const counter = make('span', 'pill');
  counter.dataset.assetFrameCounter = '';
  counter.textContent = `frame ${ctx.state.assetFrame} / ${meta.frameCount}`;

  const prev = make('button', 'btn ghost', '◀') as HTMLButtonElement;
  prev.disabled = ctx.state.assetFrame <= 0;
  prev.addEventListener('click', () => stepAssetFrame(ctx, -1));

  const next = make('button', 'btn ghost', '▶') as HTMLButtonElement;
  next.disabled = ctx.state.assetFrame >= meta.frameCount - 1;
  next.addEventListener('click', () => stepAssetFrame(ctx, 1));

  const row = make('div', 'draft-stage');
  row.append(prev, box, next);
  wrap.append(row, counter);
  return wrap;
}

/**
 * Give the sheet's box one frame's size, fitted to the stage.
 *
 * The box is the crop window: a stretched box would leave the frame as a stamp in
 * a tall empty plate. The strip inside is `frameCount` boxes wide, so sizing the
 * box sizes the crop, and the frame fills the stage instead.
 */
function fitAssetFrame(ctx: BasePort, box: HTMLElement, img: HTMLImageElement, frameCount: number): void {
  const size = (): boolean => {
    if (!img.naturalWidth || frameCount <= 0) {
      return false;
    }
    const width = ctx.regions.stage.clientWidth - 96;
    const height = ctx.regions.stage.clientHeight - 42;
    const frameWidth = img.naturalWidth / frameCount;
    const frameHeight = img.naturalHeight;
    // A stage with no measured room yet (or under test) shows the frame at 1:1
    // rather than not at all.
    const fit =
      width > 0 && height > 0
        ? Math.min(width / frameWidth, height / frameHeight, VIEW_SCALE_MAX)
        : 1;
    const scale = fit >= 1 ? Math.max(1, Math.floor(fit)) : Math.max(0.25, fit);
    box.style.width = `${frameWidth * scale}px`;
    box.style.height = `${frameHeight * scale}px`;
    return true;
  };
  if (!size()) {
    // Not decoded yet, so there is no natural size to scale from.
    img.addEventListener('load', () => size(), { once: true });
  }
  const refit = (): void => {
    if (!img.isConnected) {
      window.removeEventListener('resize', refit);
      return;
    }
    size();
  };
  window.addEventListener('resize', refit);
}

function stepAssetFrame(ctx: BasePort, delta: number): void {  const frameCount = ctx.state.asset?.meta.frameCount ?? 0;
  if (frameCount === 0) {
    return;
  }
  ctx.state.assetFrame = Math.max(0, Math.min(frameCount - 1, ctx.state.assetFrame + delta));
  ctx.renderStage();
  ctx.renderContext();
  ctx.renderInspector();
}
