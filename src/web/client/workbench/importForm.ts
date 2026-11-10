/**
 * The Import form: pick a capture, name it, register it.
 *
 * Ingest is the store's front door, but it is not where reading the store starts,
 * so the form opens from the Recordings section's `+` and closes again once a
 * capture is in. The file is read here and travels as base64 because a browser
 * cannot hand the server a path.
 */

import { slugifyId } from './state.js';
import type { WorkbenchContext } from './context.js';
import { make } from './dom.js';

/** Build the Import form, wired into `ctx`. */
export function importForm(ctx: WorkbenchContext): HTMLElement {
  const { state } = ctx;
  const form = make('form', 'rail-form');
  form.dataset.importForm = '';

  const fileRow = make('label', 'field');
  fileRow.append(make('span', 'k', 'capture'));
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.gif,image/gif';
  fileInput.dataset.importFile = '';
  fileRow.appendChild(fileInput);

  const idRow = make('div', 'rail-form-row');
  const idInput = document.createElement('input');
  idInput.dataset.importId = '';
  idInput.placeholder = 'recording id';
  idInput.setAttribute('aria-label', 'Recording id');
  idInput.value = state.pendingImportId;

  const button = make('button', 'btn small', 'Import') as HTMLButtonElement;
  button.type = 'submit';
  button.dataset.importRun = '';
  idRow.append(idInput, button);

  const message = make('p', 'rail-hint');
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

  form.append(fileRow, idRow, message);
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
    state.railForm = 'none';
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
