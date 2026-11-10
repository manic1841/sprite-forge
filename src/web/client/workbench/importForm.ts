/**
 * The Import form: pick a capture, name it, register it.
 *
 * Ingest is the store's front door. The form sits at the **top** of the
 * Recordings section so the newest thing you can do comes before the things that
 * already exist. The file is read here and travels as base64 because a browser
 * cannot hand the server a path.
 */

import { slugifyId } from './state.js';
import type { WorkbenchContext } from './context.js';
import { make } from './dom.js';

/** Build the Import form, wired into `ctx`. */
export function importForm(ctx: WorkbenchContext): HTMLElement {
  const { state } = ctx;
  const form = make('form', 'import');
  form.dataset.importForm = '';

  const fileRow = make('label', 'field');
  fileRow.append(make('span', 'k', 'capture'));
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.gif,image/gif';
  fileInput.dataset.importFile = '';
  fileRow.appendChild(fileInput);

  const idRow = make('label', 'field');
  idRow.append(make('span', 'k', 'id'));
  const idInput = document.createElement('input');
  idInput.dataset.importId = '';
  idInput.placeholder = 'mgba-2026-09';
  idInput.value = state.pendingImportId;
  idRow.appendChild(idInput);

  const button = make('button', 'btn', 'Import') as HTMLButtonElement;
  button.type = 'submit';
  button.dataset.importRun = '';
  const message = make('p', 'muted');
  message.dataset.importMessage = '';
  if (state.importNotice !== null) {
    message.textContent = state.importNotice;
  }

  // The id follows the filename until the user types their own.
  fileInput.addEventListener('change', () => {
    state.pendingFile = fileInput.files?.[0] ?? null;
    if (state.pendingFile && !state.importIdTouched) {
      state.pendingImportId = slugifyId(state.pendingFile.name);
      idInput.value = state.pendingImportId;
    }
  });
  idInput.addEventListener('input', () => {
    state.importIdTouched = true;
    state.pendingImportId = idInput.value;
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    ctx.track(runImport(ctx, message));
  });

  form.append(fileRow, idRow, button, message);
  return form;
}

/** Register the picked capture and open it. */
async function runImport(ctx: WorkbenchContext, message: HTMLElement): Promise<void> {
  const { state, api } = ctx;
  const file = state.pendingFile;
  const id = state.pendingImportId.trim();
  if (!file) {
    message.textContent = 'pick a capture file first';
    return;
  }
  if (!id) {
    message.textContent = 'an id is required';
    return;
  }
  state.importNotice = null;
  try {
    const recording = await api.ingestRecording(id, await fileToBase64(file), file.name);
    state.pendingFile = null;
    state.pendingImportId = '';
    state.importIdTouched = false;
    state.importNotice = `imported ${recording.id} (${recording.frameCount} frame(s))`;
    await ctx.rescan();
    await ctx.loadRecording(recording.id);
  } catch (error) {
    message.textContent = (error as Error).message;
  }
}

/** Read a File's bytes as base64. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
