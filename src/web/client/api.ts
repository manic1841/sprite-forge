/**
 * The browser-side half of the HTTP/JSON boundary.
 *
 * Thin wrapper over `fetch`; no business logic. Every call re-reads or writes
 * through the Node server, which delegates to the core command surface, so the
 * store stays the single source of truth.
 */

import type { CutList, StoreScan } from './types.js';

/** The workbench's calls into the server. A test can stub this wholesale. */
export interface WorkbenchApi {
  /** List the store's Recordings and committed Assets. */
  scan(): Promise<StoreScan>;
  /** Read a Recording's cut list. */
  readCutList(recordingId: string): Promise<CutList>;
  /** Add a Segment (creating a cut). */
  addSegment(
    recordingId: string,
    segment: { id: string; startFrame: number; endFrame: number; speed?: number },
  ): Promise<CutList>;
  /** Retarget an existing Segment's frame range (dragging a cut edge). */
  setSegmentRange(
    recordingId: string,
    cutId: string,
    startFrame: number,
    endFrame: number,
  ): Promise<CutList>;
  /** Remove a Segment. */
  removeSegment(recordingId: string, cutId: string): Promise<CutList>;
}

/** Build a {@link WorkbenchApi} backed by the dev server's `/api` routes. */
export function createApi(fetchImpl: typeof fetch = fetch): WorkbenchApi {
  const base = '/api';

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        typeof body === 'object' && body !== null && 'error' in body
          ? String((body as { error: unknown }).error)
          : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return body as T;
  }

  return {
    scan: () => call<StoreScan>('/store'),
    readCutList: (recordingId) => call<CutList>(`/recordings/${recordingId}/cuts`),
    addSegment: (recordingId, segment) =>
      call<CutList>(`/recordings/${recordingId}/cuts`, {
        method: 'POST',
        body: JSON.stringify(segment),
      }),
    setSegmentRange: (recordingId, cutId, startFrame, endFrame) =>
      call<CutList>(`/recordings/${recordingId}/cuts/${cutId}`, {
        method: 'PATCH',
        body: JSON.stringify({ startFrame, endFrame }),
      }),
    removeSegment: (recordingId, cutId) =>
      call<CutList>(`/recordings/${recordingId}/cuts/${cutId}`, { method: 'DELETE' }),
  };
}
