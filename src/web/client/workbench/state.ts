/**
 * The workbench's mutable state, in one place.
 *
 * The shape is deliberately flat and dumpable: a view module reads only the
 * slice it draws, and the shell decides when to re-render. Nothing here talks to
 * the network — see `./context.ts` for that.
 */

import type {
  AlignmentState,
  AlignmentWarning,
  CharacterAlignment,
  ClipDraft,
  CommittedAsset,
  CommittedSequence,
  CutList,
  ExportResult,
  RepairState,
  ReproducibilityReport,
  StoreCheckReport,
  StoreScan,
} from '../types.js';

/**
 * The faces of the stage: which *view of the active thing* is on screen.
 *
 * A face belongs to what is open, not to a fixed toolbar — Cutting only means
 * something for a Recording, and Alignment only for something with a Canvas — so
 * the mode bar offers just the faces the current target has.
 */
export const WORKBENCH_MODES = ['cut', 'clip', 'align', 'export'] as const;
export type WorkbenchMode = (typeof WORKBENCH_MODES)[number];

/**
 * The Repair tool the pointer currently carries.
 *
 * Distinct from the core `RepairTool`, which names the *operation* a gesture
 * becomes (`paint-brush`, `erase-rect`, …). This is what the user picked.
 */
export type UiTool = 'paint' | 'erase' | 'rect' | 'eyedropper';

/**
 * What the workbench currently has open.
 *
 * The target decides which faces exist and which one opens: it is the single
 * subject of the whole workspace, so nothing else has to be inferred from a mode.
 */
export type Target =
  | { kind: 'none' }
  | { kind: 'recording'; recordingId: string }
  | { kind: 'draft'; characterId: string; draftId: string }
  | { kind: 'asset'; characterId: string; assetKind: 'clip' | 'sequence'; assetId: string }
  | { kind: 'character'; characterId: string }
  | { kind: 'export'; target: string };

/** A Sequence being composed: its ordered source Clips and its lineage. */
export interface SequenceDraft {
  name: string;
  clips: string[];
  /** The Sequence this list was forked from, recorded on the next commit. */
  forkOf: string | null;
}

/** The Export form's uncommitted input, kept across re-renders. */
export interface ExportForm {
  target: string;
  animations: string[];
  situations: string;
  flipsFacing: string[];
  authoredFacing: 'right' | 'left';
  bindings: string;
}

/** Everything the workbench remembers between renders. */
export interface WorkbenchState {
  mode: WorkbenchMode;
  target: Target;
  scan: StoreScan | null;

  /** The loaded Recording and its cut list (also feeds the filmstrip). */
  recordingId: string | null;
  cutList: CutList | null;
  frame: number;
  /**
   * The open Recording's per-frame delays, in ms.
   *
   * Read from the source rather than stored, so playback honours the capture's
   * own timing instead of an invented frame rate. Empty until it has loaded.
   */
  recordingDelaysMs: number[];
  /** Whether the filmstrip is currently playing the Recording back. */
  playing: boolean;
  /**
   * A frame range picked on the filmstrip, before it is written as a Segment.
   *
   * The strip is where a cut is *made*: dragging marks the range, Play confirms
   * it, and only then is it saved. Half-open, like the stored Segment it becomes.
   */
  selection: { startFrame: number; endFrame: number } | null;
  /**
   * The Segment the inspector is editing, if one is selected.
   *
   * Segments are edited in the inspector against a selection made on the
   * filmstrip, so the stage stays pixels only and no list of buttons is repeated
   * for every cut.
   */
  selectedCut: string | null;
  /**
   * The Character a cut Segment is extracted *into*.
   *
   * Kept on state, not read off the select on every click, so it survives a
   * re-render and so a Recording can be worked against one Character throughout.
   */
  extractCharacterId: string | null;

  /** The loaded Draft. */
  draftDescriptor: ClipDraft | null;
  draftFrame: number;
  repair: RepairState | null;
  repairRevision: number;
  tool: UiTool;
  brushColor: string;
  brushSize: number;
  scope: 'frame' | 'clip';

  /** The Character the Alignment face is showing. */
  activeCharacterId: string | null;
  alignment: CharacterAlignment | null;
  alignmentWarnings: AlignmentWarning[];
  expandWidth: number;
  expandHeight: number;

  /** The loaded Export. */
  manifest: ExportResult | null;

  /** The loaded committed Asset (its meta and provenance), or `null`. */
  asset: CommittedAsset | CommittedSequence | null;
  /** The frame index shown while playing a baked sheet. */
  assetFrame: number;
  /** A Sequence being composed, if any. */
  sequenceDraft: SequenceDraft | null;
  /** The Export form's values, so a re-render never wipes half-typed input. */
  exportForm: ExportForm;
  /** The last store validation report. */
  validation: StoreCheckReport | null;
  /** The last reproducibility check for the open Asset. */
  reproducible: ReproducibilityReport | null;

  /** The message of the last failed load, shown until a load succeeds again. */
  loadError: string | null;
  /** The message of the last failed **action** (expand, offset, repair, ...). */
  actionError: string | null;

  /** The Import form's uncommitted input. */
  pendingFile: File | null;
  pendingImportId: string;
  importIdTouched: boolean;
  importNotice: string | null;
  /**
   * Which of the rail's create forms is open, if any.
   *
   * The rail lists what exists; the two forms that *add* to it only open when
   * asked for, so the scan path is never interrupted by empty inputs.
   */
  railForm: 'none' | 'import' | 'character';
}

/** A fresh state: nothing open, defaults on the tools. */
export function createState(): WorkbenchState {
  return {
    mode: 'clip',
    target: { kind: 'none' },
    scan: null,
    recordingId: null,
    cutList: null,
    frame: 0,
    recordingDelaysMs: [],
    playing: false,
    selection: null,
    selectedCut: null,
    extractCharacterId: null,
    draftDescriptor: null,
    draftFrame: 0,
    repair: null,
    repairRevision: 0,
    tool: 'paint',
    brushColor: '#ff0000',
    brushSize: 1,
    scope: 'frame',
    activeCharacterId: null,
    alignment: null,
    alignmentWarnings: [],
    expandWidth: 0,
    expandHeight: 0,
    manifest: null,
    asset: null,
    assetFrame: 0,
    sequenceDraft: null,
    exportForm: {
      target: '',
      animations: [],
      situations: '',
      flipsFacing: [],
      authoredFacing: 'right',
      bindings: '{ "idle": [] }',
    },
    validation: null,
    reproducible: null,
    loadError: null,
    actionError: null,
    pendingFile: null,
    pendingImportId: '',
    importIdTouched: false,
    importNotice: null,
    railForm: 'none',
  };
}

/** The active Draft as `{characterId, draftId}`, or `null`. */
export function activeDraft(
  state: WorkbenchState,
): { characterId: string; draftId: string } | null {
  return state.target.kind === 'draft'
    ? { characterId: state.target.characterId, draftId: state.target.draftId }
    : null;
}

/** The open committed Asset as `{characterId, assetKind, assetId}`, or `null`. */
export function activeAsset(
  state: WorkbenchState,
): { characterId: string; assetKind: 'clip' | 'sequence'; assetId: string } | null {
  return state.target.kind === 'asset'
    ? {
        characterId: state.target.characterId,
        assetKind: state.target.assetKind,
        assetId: state.target.assetId,
      }
    : null;
}

/**
 * The faces each kind of target has, default face first.
 *
 * The bar shows exactly this list, so an irrelevant face is never offered: a
 * Recording cannot be aligned, a Character has no pixels to repair, and an
 * Export has nothing to cut. Order is by the work's own progression — cutting is
 * where a Recording starts; Alignment is secondary to a Draft's repair. Export is
 * offered wherever there is a Character to export from.
 */
const FACES: Record<Target['kind'], readonly WorkbenchMode[]> = {
  none: ['clip'],
  recording: ['cut'],
  draft: ['clip', 'align', 'export'],
  asset: ['clip', 'align', 'export'],
  character: ['align', 'export'],
  export: ['export'],
};

/** The faces the current target offers, default first. */
export function facesFor(target: Target): readonly WorkbenchMode[] {
  return FACES[target.kind];
}

/** The face a target opens on. */
export function defaultFace(target: Target): WorkbenchMode {
  return FACES[target.kind][0]!;
}

/**
 * The Character whose work is open, or `null`.
 *
 * Anything hanging off a Character — a Draft, an Asset, the Alignment face — makes
 * that Character the one in play, which is what the rail expands and what the
 * Alignment face falls back to. A Recording belongs to no Character, so it keeps
 * pointing at whichever Character was last worked on.
 */
export function activeCharacter(state: WorkbenchState): string | null {
  if (
    state.target.kind === 'draft' ||
    state.target.kind === 'asset' ||
    state.target.kind === 'character'
  ) {
    return state.target.characterId;
  }
  return state.activeCharacterId;
}

/** The loaded Export target, or `null`. */
export function activeExport(state: WorkbenchState): string | null {
  return state.target.kind === 'export' ? state.target.target : null;
}

/**
 * Derive a legal id from a filename: lowercase, non-alphanumerics collapsed to a
 * single hyphen, never starting with a digit or hyphen.
 */
export function slugifyId(filename: string): string {
  const stem = filename.replace(/\.[^.]*$/, '');
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0) {
    return 'recording';
  }
  return /^[a-z]/.test(slug) ? slug : `rec-${slug}`;
}
