/**
 * Tiny element builders shared by every workbench view.
 *
 * Only the module that owns a region should build that region's nodes, so these
 * helpers stay purely mechanical: create, fill, return. Any behaviour (a click,
 * a drag) is wired by the caller.
 */

/** Create an element with an optional class and text. */
export function make(tag: string, className?: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

/** A region heading. */
export function heading(text: string): HTMLElement {
  return make('h3', 'ttl', text);
}

/** A section sub-heading inside a region. */
export function subheading(text: string): HTMLElement {
  const el = make('h3', 'ttl sub');
  el.textContent = text;
  return el;
}

/** Append a key/value row to a `<dl>`. */
export function addRow(list: HTMLElement, key: string, value: string): void {
  list.append(make('dt', 'k', key), make('dd', 'v', value));
}

/** Wrap a control in its label. */
export function labeled(text: string, control: HTMLElement): HTMLElement {
  const wrap = make('label', 'field');
  wrap.append(make('span', 'field-label', text), control);
  return wrap;
}

/** A `#rrggbb` colour input. */
export function colorInput(
  value: string,
  onChange: (value: string) => void,
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'color';
  input.setAttribute('data-repair-color', '');
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

/** A positive integer input, tagged `data-repair-size`. */
export function sizeInput(
  value: number,
  onChange: (value: number) => void,
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.setAttribute('data-repair-size', '');
  input.value = String(value);
  input.addEventListener('input', () => onChange(Number(input.value)));
  return input;
}

/** An integer input addressed by `aria-label` (offsets, canvas size). */
export function numberInput(
  value: number,
  label: string,
  onChange: (value: number) => void,
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.setAttribute('aria-label', label);
  input.value = String(value);
  input.addEventListener('input', () => onChange(Number(input.value)));
  return input;
}

/** The Repair scope select: the current frame or the whole Clip. */
export function scopeSelect(
  value: 'frame' | 'clip',
  onChange: (value: 'frame' | 'clip') => void,
): HTMLSelectElement {
  const select = document.createElement('select');
  select.setAttribute('data-repair-scope', '');
  for (const scope of ['frame', 'clip'] as const) {
    const option = document.createElement('option');
    option.value = scope;
    option.textContent = scope === 'frame' ? 'Current frame' : 'Whole Clip';
    option.selected = scope === value;
    select.appendChild(option);
  }
  select.addEventListener('change', () => onChange(select.value as 'frame' | 'clip'));
  return select;
}
