/**
 * Inline glyphs for the control bars.
 *
 * Icons are inlined rather than loaded from `site/assets/icons` because the
 * workbench tints them: `stroke="currentColor"` lets a tool follow the dock
 * button's own colour, so the pressed state and the disabled state need no
 * second asset. Each glyph is a single Lucide path (ISC) drawn on a 24 grid.
 */

const PATHS = {
  /** A repair brush. */
  brush:
    'm11 10 3 3M9.969 17.031 21.378 5.624a1 1 0 0 0-3.002-3.002L6.967 14.031M6.5 21A3.5 3.5 0 1 0 3 17.5a2.62 2.62 0 0 1-.708 1.792A1 1 0 0 0 3 21z',
  /** A rubber, for erasing back to transparent. */
  eraser:
    'm7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21M22 21H7m-2-10 9 9',
  /** A rectangle, for the drag-a-box repair. */
  rect: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
  /** A pipette, for picking a colour out of the frame. */
  eyedropper:
    'm2 22 1-1h3l9-9M3 21v-3l9-9m3-4 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z',
} as const;

/** A glyph the bar can draw. */
export type IconName = keyof typeof PATHS;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build one glyph.
 *
 * The glyph is decorative: every button that carries one also sets its own
 * `aria-label`, so a screen reader announces the verb once, not the shape.
 */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ic ic-svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PATHS[name]);
  svg.appendChild(path);
  return svg;
}
