/**
 * The contract the shell hands to its views.
 *
 * Views never import the shell and never import each other: they receive a
 * narrow {@link BasePort} (see `./ports.ts`) plus the one session their region
 * drives. This module is the composed shape the shell itself builds.
 */

import type { CutSession, CutSessionDeps } from './cutSession.js';
import type { DraftEditor } from './draftEditor.js';
import type { BasePort } from './ports.js';

/** The persistent region nodes, so a view can target its own container. */
export interface Regions {
  readonly rail: HTMLElement;
  readonly stage: HTMLElement;
  readonly filmstrip: HTMLElement;
  readonly inspector: HTMLElement;
  /** The shell header: the global faces only. */
  readonly header: HTMLElement;
  /** The bar above the stage: what is open and the faces that belong to it. */
  readonly targetBar: HTMLElement;
  readonly context: HTMLElement;
}

/** Everything the shell offers its views, composed from the narrow ports. */
export interface WorkbenchContext extends BasePort {
  readonly root: HTMLElement;
  /** Re-render the whole shell. */
  render(): void;
  /** Re-render one region. */
  renderLibrary(): void;
  renderStage(): void;
  renderFilmstrip(): void;
  renderInspector(): void;
  renderContext(): void;

  /** Register a promise so a harness can await it via `settled`. */
  track(promise: Promise<void>): Promise<void>;

  readonly cut: CutSession;
  /** The dependency bag the session was built from, so detached controls rebuild. */
  readonly cutDeps: CutSessionDeps;
  readonly draft: DraftEditor;
}
