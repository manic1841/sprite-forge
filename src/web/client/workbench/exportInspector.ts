/**
 * The inspector for an **Export**: the live Manifest, exactly as the server read
 * it back and validated it.
 *
 * The form that produces an Export lives in the stage; this panel is the receipt.
 */

import type { ExportInspectorPort } from './ports.js';
import { make, subheading } from './dom.js';

export function exportInspector(ctx: ExportInspectorPort, info: HTMLElement): void {
  const section = make('section', 'inspector-section');
  section.dataset.inspectorSection = 'export';
  section.appendChild(subheading('Manifest'));

  const manifest = ctx.state.manifest?.manifest;
  if (!manifest) {
    section.appendChild(make('p', 'muted', 'The live manifest appears once an Export is loaded.'));
    info.appendChild(section);
    return;
  }

  const pre = document.createElement('pre');
  pre.className = 'manifest';
  pre.dataset.manifest = '';
  pre.dataset.manifestTarget = manifest.target;
  pre.textContent = JSON.stringify(manifest, null, 2);
  section.appendChild(pre);
  info.appendChild(section);
}
