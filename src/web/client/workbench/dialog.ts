/**
 * Confirmations, one-line asks and either/or choices, drawn in the page rather than
 * by the browser.
 *
 * `window.confirm` and `window.prompt` are not implemented everywhere the
 * workbench runs — the embedded browser reports `prompt() is not supported` and
 * throws — so every ask goes through these instead. All three return a promise, so
 * a call site reads the same as the native version did:
 *
 * ```ts
 * if (!(await confirmAction('Delete segment "walk"?'))) return;
 * const id = await promptText('New Character id to extract into:');
 * const pick = await chooseAction('Extract into which Character?', options);
 * ```
 */

interface DialogParts {
  readonly overlay: HTMLElement;
  readonly input: HTMLInputElement | null;
  readonly form: HTMLFormElement;
  /** The chosen value, for a choice dialog; read on submit. */
  readonly choice: () => string;
}

/** A choice offered by {@link chooseAction}. */
export interface DialogOption {
  value: string;
  label: string;
  /** A second line under the label, e.g. what the option holds. */
  note?: string;
}

/** Build the shared shell: a modal form with a message, an optional input, two buttons. */
function build(
  message: string,
  options: {
    defaultValue?: string;
    confirmLabel: string;
    choices?: readonly DialogOption[];
  },
): DialogParts {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-backdrop';
  overlay.dataset.dialog = '';

  const form = document.createElement('form');
  form.className = 'dialog';
  form.dataset.dialogForm = '';

  const text = document.createElement('p');
  text.className = 'dialog-message';
  text.dataset.dialogMessage = '';
  // The messages carry caller-built ids, so they are set as text, never HTML.
  text.textContent = message;
  form.appendChild(text);

  let input: HTMLInputElement | null = null;
  if (options.defaultValue !== undefined) {
    input = document.createElement('input');
    input.dataset.dialogInput = '';
    input.value = options.defaultValue;
    form.appendChild(input);
  }

  // A choice is a radio list rather than a `select`: every option stays readable,
  // and each can carry a note.
  const choices = options.choices;
  if (choices) {
    const list = document.createElement('div');
    list.className = 'dialog-choices';
    list.dataset.dialogChoices = '';
    choices.forEach((choice, index) => {
      const row = document.createElement('label');
      row.className = 'dialog-choice';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'dialog-choice';
      radio.value = choice.value;
      radio.dataset.dialogChoice = choice.value;
      // The first option is the one that needs no explaining.
      radio.checked = index === 0;
      const words = document.createElement('span');
      words.className = 'dialog-choice-text';
      words.append(makeSpan('dialog-choice-label', choice.label));
      if (choice.note !== undefined) {
        words.append(makeSpan('dialog-choice-note', choice.note));
      }
      row.append(radio, words);
      list.appendChild(row);
    });
    form.appendChild(list);
  }

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn small ghost';
  cancel.dataset.dialogCancel = '';
  cancel.textContent = 'Cancel';

  const confirm = document.createElement('button');
  confirm.type = 'submit';
  confirm.className = 'btn small';
  confirm.dataset.dialogConfirm = '';
  confirm.textContent = options.confirmLabel;

  actions.append(cancel, confirm);
  form.appendChild(actions);
  overlay.appendChild(form);
  // Inside the shell, so the dialog inherits the workbench's palette variables;
  // its `position: fixed` keeps it out of the shell's own scroll and clipping.
  (document.querySelector('.wb-shell') ?? document.body).appendChild(overlay);
  (input ?? overlay.querySelector<HTMLInputElement>('[data-dialog-choice]'))?.focus();

  return {
    overlay,
    input,
    form,
    choice: () =>
      overlay.querySelector<HTMLInputElement>('[data-dialog-choice]:checked')?.value ?? '',
  };
}

/** A `<span>` with a class and text, for the choice rows. */
function makeSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/** Run the dialog, resolving with the submitted value (`null` on cancel / Escape). */
function open(parts: DialogParts, valueOf: () => string): Promise<string | null> {
  return new Promise((resolve) => {
    const close = (result: string | null): void => {
      parts.overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      }
    };
    parts.form.addEventListener('submit', (event) => {
      event.preventDefault();
      close(valueOf());
    });
    parts.overlay
      .querySelector('[data-dialog-cancel]')
      ?.addEventListener('click', () => close(null));
    document.addEventListener('keydown', onKey);
  });
}

/** Ask for confirmation; `true` only when the user submits. */
export async function confirmAction(
  message: string,
  confirmLabel = 'Confirm',
): Promise<boolean> {
  return (await open(build(message, { confirmLabel }), () => 'ok')) !== null;
}

/**
 * Ask for a one-line answer.
 *
 * Resolves `null` when cancelled, and `''` when submitted empty — the caller
 * decides whether an empty answer is meaningful.
 */
export async function promptText(
  message: string,
  defaultValue = '',
  confirmLabel = 'OK',
): Promise<string | null> {
  const parts = build(message, { defaultValue, confirmLabel });
  return await open(parts, () => parts.input?.value.trim() ?? '');
}

/**
 * Pick one of several answers.
 *
 * Used where the workbench must not guess: the first option is preselected, so the
 * dialog still answers with one Enter, but nothing is inferred behind the user's
 * back. Resolves the chosen `value`, or `null` when cancelled.
 */
export async function chooseAction(
  message: string,
  choices: readonly DialogOption[],
  confirmLabel = 'OK',
): Promise<string | null> {
  const parts = build(message, { choices, confirmLabel });
  return await open(parts, () => parts.choice());
}
