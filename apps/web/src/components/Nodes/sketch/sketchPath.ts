import getStroke from 'perfect-freehand';

import { ACCENT_PALETTE, type ColorPickerOption } from '@sediment/shared';

export const SKETCH_OPTIONS = {
  size: 4,
  thinning: 0.4,
  smoothing: 0.5,
  streamline: 0.35,
  simulatePressure: false,
  easing: (t: number) => t,
  start: { taper: 0, easing: (t: number) => t, cap: true },
  end: { taper: 0, easing: (t: number) => t, cap: true },
  last: false,
};

/**
 * Default stroke color when `data.strokeColor` is unset (legacy data).
 *
 * Stored as a picker token (e.g. `'black'`, `'grey'`); resolved to a CSS
 * color at render time via `resolveAccent`. `'black'` and `'white'` are
 * sketch-only picker entries that are not part of `ACCENT_PALETTE`, so
 * they fall through `resolveAccent`'s passthrough branch and render as
 * the literal CSS color keyword.
 */
export const DEFAULT_STROKE_COLOR = 'black';

/** Default stroke thickness when `data.strokeSize` is unset (legacy data). */
export const DEFAULT_STROKE_SIZE = SKETCH_OPTIONS.size;

/** UI bounds for the stroke-size slider. */
export const SKETCH_SIZE_MIN = 1;
export const SKETCH_SIZE_MAX = 32;

/**
 * Sketch stroke palette.
 *
 * Diverges from node `style.accent` only by prepending `black` — sketch
 * ink legitimately needs a true black for high-contrast strokes, which
 * is not part of `ACCENT_PALETTE`. `white` lives in `ACCENT_PALETTE`
 * itself so it's picked up via the spread; resolved to its hex value at
 * render time via `resolveAccent`.
 */
export const SKETCH_COLOR_OPTIONS: readonly ColorPickerOption[] = [
  { token: 'black', name: 'Black', value: '#000000' },
  ...ACCENT_PALETTE,
];

/** Canonical perfect-freehand outline for client renderers. */
export function buildStrokeOutline(
  points: number[][],
  size: number = DEFAULT_STROKE_SIZE,
): number[][] {
  return getStroke(points, { ...SKETCH_OPTIONS, size });
}

/** Convert a perfect-freehand outline to an SVG path. */
function outlineToPath(outline: number[][]): string {
  if (outline.length === 0) return '';

  const d = outline.reduce(
    (commands: (string | number)[], [x0, y0], index, vertices) => {
      const [x1, y1] = vertices[(index + 1) % vertices.length];
      commands.push(x0, y0, ',', (x0 + x1) / 2, (y0 + y1) / 2);
      return commands;
    },
    ['M', ...outline[0], 'Q'],
  );
  d.push('Z');
  return d.join(' ');
}

/**
 * Convert pressure-bearing input points to an SVG path. `zoom` is retained for
 * the existing screen-space preview API; all outline generation flows through
 * the same {@link buildStrokeOutline} helper.
 */
export function pointsToPath(
  points: number[][],
  zoom = 1,
  size: number = DEFAULT_STROKE_SIZE,
): string {
  return outlineToPath(buildStrokeOutline(points, size * zoom));
}
