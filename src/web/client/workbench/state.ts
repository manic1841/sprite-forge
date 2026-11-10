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

/** The modes of the stage: which *face* of the active thing is on screen. */
export const WORKBENCH_MODES = ['clip', 'align', 'export'] as const;
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
 * The stage and inspector follow this, not the mode: a loaded Recording and a
 * loaded Draft both live in the clip face, so a click on either keeps the whole
 * workspace on one screen instead of swapping it out.
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
