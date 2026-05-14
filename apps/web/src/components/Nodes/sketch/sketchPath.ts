import { ACCENT_PICKER_OPTIONS } from '@sediment/shared';
import getStroke from 'perfect-freehand';

export const SKETCH_OPTIONS = {
  size: 4,
  thinning: 0.5,
  smoothing: 0.5,
  streamline: 0.5,
  easing: (t: number) => t,
  start: { taper: 1, easing: (t: number) => t, cap: true },
  end: { taper: 1, easing: (t: number) => t, cap: true },
};

/**
 * Default stroke color when `data.strokeColor` is unset (legacy data).
 *
 * Stored as a picker token (e.g. `'black'`, `'grey'`); resolved to a CSS
 * color at render time via `resolveAccent`. `'black'` and `'white'` are
 * picker-only entries that fall through to the CSS keyword via the
 * passthrough branch (see shared `color.ts`).
 */
export const DEFAULT_STROKE_COLOR = 'black';

/** Default stroke thickness when `data.strokeSize` is unset (legacy data). */
export const DEFAULT_STROKE_SIZE = SKETCH_OPTIONS.size;

/** UI bounds for the stroke-size slider. */
export const SKETCH_SIZE_MIN = 1;
export const SKETCH_SIZE_MAX = 32;

/**
 * Sketch palette. Reuses the shared `ACCENT_PICKER_OPTIONS` so sketch
 * strokes share the canvas's emphasis-color vocabulary (grey / red /
 * orange / amber / green / blue / purple, plus white).
 *
 * Stored as a palette **token** on `SketchNodeData.strokeColor`;
 * resolved to a CSS color at render time via `resolveAccent` so a future
 * theme swap propagates automatically. Legacy hex strings still render
 * thanks to `resolveAccent`'s passthrough behaviour.
 */
export const SKETCH_COLOR_OPTIONS = ACCENT_PICKER_OPTIONS;

/**
 * Convert a perfect-freehand stroke (array of [x,y] points) to an SVG
 * path `d` attribute using quadratic bezier curves.
 */
function getSvgPathFromStroke(stroke: number[][]): string {
  if (!stroke.length) return '';

  const d = stroke.reduce(
    (acc: (string | number)[], [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, ',', (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ['M', ...stroke[0], 'Q'],
  );
  d.push('Z');
  return d.join(' ');
}

/**
 * Convert raw input points ([x, y, pressure]) to an SVG path `d` attribute.
 * Uses perfect-freehand to produce smooth, pressure-sensitive strokes.
 *
 * @param points  Pressure-bearing input points.
 * @param zoom    Viewport zoom; the stroke base size is multiplied by this
 *                so on-screen thickness stays visually consistent across
 *                zoom levels.
 * @param size    Base stroke thickness in flow-space units. Defaults to
 *                {@link DEFAULT_STROKE_SIZE} for legacy nodes that never
 *                had `data.strokeSize`.
 */
export function pointsToPath(
  points: number[][],
  zoom = 1,
  size: number = DEFAULT_STROKE_SIZE,
): string {
  const stroke = getStroke(points, {
    ...SKETCH_OPTIONS,
    size: size * zoom,
  });
  return getSvgPathFromStroke(stroke);
}
