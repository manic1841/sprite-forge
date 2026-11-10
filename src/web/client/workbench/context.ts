/**
 * The contract a view module needs from the shell.
 *
 * Views never import the shell and never import each other: they receive this,
 * read the state slice they draw, and call back for anything that has to touch
 * the store or re-render a sibling region. That is what keeps every module
 * testable and replaceable on its own.
 */

import type { WorkbenchApi } from '../api.js';
import type { WorkbenchState } from './state.js';

/** The persistent region nodes, so a view can target its own container. */
export interface Regions {
  readonly rail: HTMLElement;
  readonly stage: HTMLElement;
  readonly filmstrip: HTMLElement;
  readonly inspector: HTMLElement;
  /** The shell header: breadcrumb and faces. */
  readonly header: HTMLElement;
  readonly context: HTMLElement;
}

/** Services the shell offers its views. */
export interface WorkbenchContext {
  readonly api: WorkbenchApi;
  readonly state: WorkbenchState;
  readonly root: HTMLElement;
  readonly regions: Regions;

  /** Re-render the whole shell. */
  render(): void;
  /** Re-render one region. */
  renderLibrary(): void;
  renderStage(): void;
  renderFilmstrip(): void;
  renderInspector(): void;
  renderContext(): void;

  /** Open a Recording (guarded: a rejection becomes visible state). */
  loadRecording(recordingId: string): Promise<void>;
  /** Open a Draft (guarded). */
  loadDraft(characterId: string, draftId: string): Promise<void>;
  /** Open a committed Asset (guarded). */
  loadAsset(characterId: string, assetKind: 'clip' | 'sequence', assetId: string): Promise<void>;
  /** Open a Character itself: its Alignment face, where its Canvas is framed. */
  loadCharacter(characterId: string): Promise<void>;
  /** Show a Character's alignment face (guarded). */
  loadAlignment(characterId: string): Promise<void>;
  /** Open an Export (guarded). */
  loadExport(target: string): Promise<void>;
  /**
   * Run a user action, turning a rejection into visible state.
   *
   * Everything a click can start goes through here: without it a refused
   * `expand-canvas` was only ever seen in the console.
   */
  run(label: string, body: () => Promise<void>): Promise<void>;
  /** Switch the active face. */
  setMode(mode: WorkbenchState['mode']): void;
  /** Re-scan the store into `state.scan`. */
  rescan(): Promise<void>;
  /** Register a promise so a harness can await it via `settled()`. */
  track(promise: Promise<void>): Promise<void>;
}
