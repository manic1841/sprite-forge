import { describe, expect, it } from 'vitest';
import { createApi } from '../src/web/client/api.js';

/**
 * Image URLs must change when the pixels do.
 *
 * Frames and sheets are rewritten in place by a Repair or a Canvas resize, so the
 * path alone is not a version: the browser decodes once and keeps the bitmap, and
 * an identical URL puts the old pixels in the new, larger box. The api appends an
 * epoch and bumps it on every pixel-mutating call.
 */
const stubFetch = (): typeof fetch =>
  (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

describe('image URL cache-busting', () => {
  it('version-busts frame and sheet URLs', () => {
    const api = createApi(stubFetch());
    expect(api.frameUrl('hero', 'wip', 0)).toBe('/api/characters/hero/drafts/wip/frames/0?v=0');
    expect(api.sheetUrl('hero', 'clip', 'walk')).toBe('/api/characters/hero/clips/walk/sheet?v=0');
  });

  it('changes the URLs after a resize, a fit or a framing', async () => {
    const api = createApi(stubFetch());

    await api.resizeCanvas('hero', 4, 6);
    expect(api.frameUrl('hero', 'wip', 0)).toBe('/api/characters/hero/drafts/wip/frames/0?v=1');

    await api.fitCanvas('hero');
    expect(api.sheetUrl('hero', 'clip', 'walk')).toBe('/api/characters/hero/clips/walk/sheet?v=2');

    await api.frameCanvas('hero', { recordingId: 'idle' });
    expect(api.frameUrl('hero', 'wip', 0)).toContain('?v=3');
  });

  it('keeps the Repair revision alongside the bust', async () => {
    const api = createApi(stubFetch());
    expect(api.frameUrl('hero', 'wip', 2, 5)).toBe('/api/characters/hero/drafts/wip/frames/2?v=0&r=5');
  });

  it('bumps on a Repair so the repaired frame is re-fetched', async () => {
    const api = createApi(stubFetch());
    await api.appendRepairOperation('hero', 'wip', { kind: 'erase', frame: 0, rect: { x: 0, y: 0, width: 1, height: 1 } } as never);
    expect(api.frameUrl('hero', 'wip', 0)).toBe('/api/characters/hero/drafts/wip/frames/0?v=1');

    await api.undoRepairOperation('hero', 'wip');
    expect(api.frameUrl('hero', 'wip', 0)).toBe('/api/characters/hero/drafts/wip/frames/0?v=2');
  });
});
