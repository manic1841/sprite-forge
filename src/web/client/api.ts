/**
 * The browser-side half of the HTTP/JSON boundary.
 *
 * Thin wrapper over `fetch`; no business logic. Every call re-reads or writes
 * through the Node server, which delegates to the core command surface, so the
 * store stays the single source of truth.
 */

import type {
  AlignmentState,
  Canvas,
  CharacterAlignment,
  ClipDraft,
  CommittedAsset,
  CommittedSequence,
  CreatedCharacter,
  CutList,
  DerivedAnchor,
  ExpandCanvasResult,
  ExportBindings,
  ExportResult,
  Facing,
  IngestedRecording,
  PlacementOffset,
  RecordingDelays,
  RepairOperationInput,
  RepairState,
  ReproducibilityReport,
  SequenceFork,
  StoreCheckReport,
  StoreScan,
} from './types.js';

/** The workbench's calls into the server. A test can stub this wholesale. */
export interface WorkbenchApi {
  /** List the store's Recordings, Drafts and committed Assets. */
  scan(): Promise<StoreScan>;
  /**
   * Register an uploaded capture as a Recording. The bytes travel as base64
   * because the browser cannot hand the server a path.
   */
  ingestRecording(
    id: string,
    dataBase64: string,
    filename?: string,
  ): Promise<IngestedRecording>;
  /** Read a Recording's cut list. */
  readCutList(recordingId: string): Promise<CutList>;
  /**
   * Read a Recording's per-frame delays.
   *
   * Delays are not part of the cut list, so playback asks for them separately
   * rather than inventing a frame rate.
   */
  readRecordingDelays(recordingId: string): Promise<RecordingDelays>;
  /**
   * The URL a Recording frame's PNG is served from, for an `<img src>`.
   * Synchronous: it is a URL, not a fetch.
   */
  recordingFrameUrl(recordingId: string, index: number): string;
  /** Preview the Canvas/Anchor a Recording (or Segment) would derive. */
  deriveAnchor(recordingId: string, cutId?: string): Promise<DerivedAnchor>;
  /**
   * Create a Character. Without a Canvas the Character starts **blank** on a
   * provisional one, to be framed from footage later.
   */
  createCharacter(
    id: string,
    canvas?: { width: number; height: number; anchorX: number; anchorY: number },
  ): Promise<CreatedCharacter>;
  /** Extract a Segment into a Clip Draft. */
  extractClipDraft(
    characterId: string,
    request: { recordingId: string; cutId: string; draftId?: string },
  ): Promise<ClipDraft>;
  /** Commit a Draft into an immutable Clip. */
  commitDraft(characterId: string, draftId: string, name: string): Promise<CommittedAsset>;
  /** Rename a Segment's cut id. */
  renameSegment(recordingId: string, cutId: string, newId: string): Promise<CutList>;
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
  /** Read a Draft descriptor plus the store-relative paths of its frames. */
  readClipDraft(characterId: string, draftId: string): Promise<ClipDraft>;
  /**
   * The URL a Draft frame's PNG is served from, for an `<img src>`. Synchronous:
   * it is a URL, not a fetch, so the browser loads the image itself. `revision`
   * busts the cache after a Repair so the repaired frame is re-fetched.
   */
  frameUrl(characterId: string, draftId: string, index: number, revision?: number): string;
  /** Read a Draft's Repair state: its ordered operations plus validity warnings. */
  readRepair(characterId: string, draftId: string): Promise<RepairState>;
  /** Append one Repair operation to the Draft's script. */
  appendRepairOperation(
    characterId: string,
    draftId: string,
    operation: RepairOperationInput,
  ): Promise<RepairState>;
  /** Undo the Draft's last Repair operation. */
  undoRepairOperation(characterId: string, draftId: string): Promise<RepairState>;
  /** Sample the colour at a pixel of the Draft's current de-backgrounded frame. */
  sampleRepairColor(
    characterId: string,
    draftId: string,
    frame: number,
    x: number,
    y: number,
  ): Promise<string>;
  /** Read a Character's Canvas and every Clip/Draft placement offset (Alignment stage). */
  readCharacterAlignment(characterId: string): Promise<CharacterAlignment>;
  /** Read a Draft's placement offset plus alignment-validity warnings. */
  readDraftAlignment(characterId: string, draftId: string): Promise<AlignmentState>;
  /** Set (or clear) a Draft's manual placement offset. */
  setPlacementOffset(
    characterId: string,
    draftId: string,
    offset: PlacementOffset,
  ): Promise<ClipDraft>;
  /** Grow a Character's Canvas and re-bake its committed Clips. */
  expandCanvas(characterId: string, width: number, height: number): Promise<ExpandCanvasResult>;
  /**
   * Frame a blank Character from a Segment: replace its provisional Canvas with the
   * framing the footage implies (grow-only once the Character has work).
   */
  frameCanvas(
    characterId: string,
    request: { recordingId: string; cutId?: string },
  ): Promise<Canvas>;
  /**
   * The URL a committed Asset's sheet is served from, for an `<img src>` (the
   * Alignment stage ghosts Clips on the Canvas with it).
   */
  sheetUrl(characterId: string, kind: 'clip' | 'sequence', id: string): string;
  /** Run an Export: gather an Asset subset into a closed Manifest plus sheets. */
  exportCharacter(
    characterId: string,
    target: string,
    request: ExportRequest,
  ): Promise<ExportResult>;
  /** Read an existing Export's live, validated Manifest (the Export stage). */
  readManifest(target: string): Promise<ExportResult>;
  /** Read a committed Clip's validated meta, provenance and sheet path. */
  readClip(characterId: string, clipId: string): Promise<CommittedAsset>;
  /** Read a committed Sequence's validated meta, provenance and source Clips. */
  readSequence(characterId: string, sequenceId: string): Promise<CommittedSequence>;
  /** Fork a committed Clip into a new Draft. */
  forkClip(characterId: string, clipId: string, draftId?: string): Promise<ClipDraft>;
  /** Fork a committed Sequence into its ordered Clip list, to edit and re-commit. */
  forkSequence(characterId: string, sequenceId: string): Promise<SequenceFork>;
  /** Commit an ordered Clip list as a new Sequence. */
  commitSequence(
    characterId: string,
    sequenceId: string,
    clips: string[],
  ): Promise<CommittedSequence>;
  /** Throw away a Draft and the Repair script it owns. */
  discardDraft(characterId: string, draftId: string): Promise<void>;
  /** Delete a committed Asset (refused while a Sequence still uses a Clip). */
  deleteAsset(characterId: string, kind: 'clip' | 'sequence', id: string): Promise<void>;
  /** Re-bake one Asset and diff it against what is stored. */
  verifyReproducible(
    characterId: string,
    kind: 'clip' | 'sequence',
    id: string,
  ): Promise<ReproducibilityReport>;
  /** Validate the whole store. */
  validateStore(): Promise<StoreCheckReport>;
}

/** The Export stage's inputs; the server passes them straight to `exportCharacter`. */
export interface ExportRequest {
  animations?: string[];
  bindings: ExportBindings;
  situations?: string[];
  flipsFacing?: string[];
  authoredFacing?: Facing;
  exportedAt?: string;
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
    ingestRecording: (id, dataBase64, filename) =>
      call<IngestedRecording>('/recordings', {
        method: 'POST',
        body: JSON.stringify({ id, dataBase64, filename }),
      }),
    readCutList: (recordingId) => call<CutList>(`/recordings/${recordingId}/cuts`),
    readRecordingDelays: (recordingId) =>
      call<RecordingDelays>(`/recordings/${recordingId}/delays`),
    recordingFrameUrl: (recordingId, index) =>
      `${base}/recordings/${recordingId}/frames/${index}`,
    deriveAnchor: (recordingId, cutId) =>
      call<DerivedAnchor>(
        `/recordings/${recordingId}/anchor${cutId === undefined ? '' : `?cut=${cutId}`}`,
      ),
    createCharacter: (id, canvas) =>
      call<CreatedCharacter>('/characters', {
        method: 'POST',
        body: JSON.stringify({ id, ...canvas }),
      }),
    extractClipDraft: (characterId, request) =>
      call<ClipDraft>(`/characters/${characterId}/drafts`, {
        method: 'POST',
        body: JSON.stringify(request),
      }),
    commitDraft: (characterId, draftId, name) =>
      call<CommittedAsset>(`/characters/${characterId}/drafts/${draftId}/commit`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    renameSegment: (recordingId, cutId, newId) =>
      call<CutList>(`/recordings/${recordingId}/cuts/${cutId}/rename`, {
        method: 'POST',
        body: JSON.stringify({ newId }),
      }),
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
    readClipDraft: (characterId, draftId) =>
      call<ClipDraft>(`/characters/${characterId}/drafts/${draftId}`),
    frameUrl: (characterId, draftId, index, revision) => {
      const base = `/api/characters/${characterId}/drafts/${draftId}/frames/${index}`;
      return revision && revision > 0 ? `${base}?r=${revision}` : base;
    },
    readRepair: (characterId, draftId) =>
      call<RepairState>(`/characters/${characterId}/drafts/${draftId}/repair`),
    appendRepairOperation: (characterId, draftId, operation) =>
      call<RepairState>(`/characters/${characterId}/drafts/${draftId}/repair/operations`, {
        method: 'POST',
        body: JSON.stringify(operation),
      }),
    undoRepairOperation: (characterId, draftId) =>
      call<RepairState>(`/characters/${characterId}/drafts/${draftId}/repair/undo`, {
        method: 'POST',
      }),
    sampleRepairColor: async (characterId, draftId, frame, x, y) => {
      const body = await call<{ color: string }>(
        `/characters/${characterId}/drafts/${draftId}/repair/sample?frame=${frame}&x=${x}&y=${y}`,
      );
      return body.color;
    },
    readCharacterAlignment: (characterId) =>      call<CharacterAlignment>(`/characters/${characterId}/alignment`),
    readDraftAlignment: (characterId, draftId) =>
      call<AlignmentState>(`/characters/${characterId}/drafts/${draftId}/alignment`),
    setPlacementOffset: (characterId, draftId, offset) =>
      call<ClipDraft>(`/characters/${characterId}/drafts/${draftId}/alignment/offset`, {
        method: 'POST',
        body: JSON.stringify(offset),
      }),
    expandCanvas: (characterId, width, height) =>
      call<ExpandCanvasResult>(`/characters/${characterId}/expand-canvas`, {
        method: 'POST',
        body: JSON.stringify({ width, height }),
      }),
    frameCanvas: (characterId, request) =>
      call<Canvas>(`/characters/${characterId}/frame-canvas`, {
        method: 'POST',
        body: JSON.stringify(request),
      }),
    sheetUrl: (characterId, kind, id) =>
      `/api/characters/${characterId}/${kind === 'clip' ? 'clips' : 'sequences'}/${id}/sheet`,
    exportCharacter: (characterId, target, request) =>
      call<ExportResult>(`/characters/${characterId}/exports/${target}`, {
        method: 'POST',
        body: JSON.stringify(request),
      }),
    readManifest: (target) => call<ExportResult>(`/exports/${target}/manifest`),
    readClip: (characterId, clipId) =>
      call<CommittedAsset>(`/characters/${characterId}/clips/${clipId}`),
    readSequence: (characterId, sequenceId) =>
      call<CommittedSequence>(`/characters/${characterId}/sequences/${sequenceId}`),
    forkClip: (characterId, clipId, draftId) =>
      call<ClipDraft>(`/characters/${characterId}/clips/${clipId}/fork`, {
        method: 'POST',
        body: JSON.stringify(draftId === undefined ? {} : { draftId }),
      }),
    forkSequence: (characterId, sequenceId) =>
      call<SequenceFork>(`/characters/${characterId}/sequences/${sequenceId}/fork`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    commitSequence: (characterId, sequenceId, clips) =>
      call<CommittedSequence>(`/characters/${characterId}/sequences`, {
        method: 'POST',
        body: JSON.stringify({ name: sequenceId, clips }),
      }),
    discardDraft: async (characterId, draftId) => {
      await call<{ discarded: string }>(`/characters/${characterId}/drafts/${draftId}/discard`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    deleteAsset: async (characterId, kind, id) => {
      const folder = kind === 'clip' ? 'clips' : 'sequences';
      await call<{ deleted: string }>(`/characters/${characterId}/${folder}/${id}`, {
        method: 'DELETE',
      });
    },
    verifyReproducible: (characterId, kind, id) =>
      call<ReproducibilityReport>(
        `/characters/${characterId}/${kind === 'clip' ? 'clips' : 'sequences'}/${id}/reproducible`,
      ),
    validateStore: () => call<StoreCheckReport>('/validate'),
  };
}
