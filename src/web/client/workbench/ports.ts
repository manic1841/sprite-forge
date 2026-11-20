/**
 * The narrow capability each region gets from the shell.
 *
 * A view receives its port, never the shell and never a sibling. Every port
 * carries the one **session** its region drives (cut or draft) plus the repaints
 * it may ask for, so a view cannot reach into another region's rules.
 */

import type { WorkbenchApi } from '../api.js';
import type { CutSession, CutSessionDeps } from './cutSession.js';
import type { DraftEditor } from './draftEditor.js';
import type { SequencePreview } from './sequencePreview.js';
import type { WorkbenchState, WorkbenchMode } from './state.js';
import type { Regions } from './context.js';

/** What every view may ask the shell for. */
export interface BasePort {
  readonly api: WorkbenchApi;
  /** The state. A view reads the slice it draws (and only writes its own). */
  readonly state: WorkbenchState;
  readonly regions: Regions;
  /** Repaint one region. */
  renderLibrary(): void;
  renderStage(): void;
  renderFilmstrip(): void;
  renderInspector(): void;
  renderContext(): void;
  /** Switch the active face. */
  setMode(mode: WorkbenchMode): void;
  /** Run a user action, surfacing a rejection as visible state. */
  run(label: string, body: () => Promise<void>): void;
  /** Register a promise so a harness can await it. */
  track(promise: Promise<void>): Promise<void>;
  loadRecording(recordingId: string): Promise<void>;
  loadDraft(characterId: string, draftId: string): Promise<void>;
  loadAsset(characterId: string, assetKind: 'clip' | 'sequence', assetId: string): Promise<void>;
  loadCharacter(characterId: string): Promise<void>;
  loadAlignment(characterId: string): Promise<void>;
  loadExport(target: string): Promise<void>;
  rescan(): Promise<void>;
}

/** The Library rail: picks things, adds a Character or an Import. */
export interface LibraryPort extends BasePort {
  readonly cut: CutSession;
}

/** The filmstrip: marks ranges and previews them through the cut session. */
export interface FilmstripPort extends BasePort {
  readonly cut: CutSession;
  /** The session's own dependency bag, so detached controls can be rebuilt. */
  readonly cutDeps: CutSessionDeps;
}

/** The cut stage: the Recording's frame, stepped through the cut session. */
export interface CutStagePort extends BasePort {
  readonly cut: CutSession;
}

/** The Recording inspector: the Segment editor and the footage picker. */
export interface RecordingInspectorPort extends BasePort {
  readonly cut: CutSession;
}

/** The clip stage: a Draft's frames and Repair bench. */
export interface ClipStagePort extends BasePort {
  readonly draft: DraftEditor;
}

/** The Draft inspector: facts, repair log, commit and discard. */
export interface DraftInspectorPort extends BasePort {
  readonly draft: DraftEditor;
}

/** The inspector router mounts every face's section, so it carries every session. */
export interface InspectorPort extends RecordingInspectorPort, DraftInspectorPort, ComposeStagePort {}

/** The Compose stage: a Character's composition, previewed. */
export interface ComposeStagePort extends BasePort {
  readonly preview: SequencePreview;
}

/** The Compose inspector: the Clip list, the name and the exits. */
export interface ComposeInspectorPort extends ComposeStagePort {}

/**
 * Alignment: placement of a Draft, or of a composition's slot.
 *
 * It carries the preview because a re-align is retargeted from here — which Clip
 * the offset applies to is the first thing the panel has to let you say.
 */
export interface AlignInspectorPort extends BasePort {
  readonly preview: SequencePreview;
}

/** All the remaining inspectors only need the base capabilities. */
export type AssetViewStagePort = BasePort;
export type AssetInspectorPort = BasePort;
export type CharacterInspectorPort = BasePort;
export type ExportInspectorPort = BasePort;
export type AlignStagePort = BasePort;
export type ExportStagePort = BasePort;
