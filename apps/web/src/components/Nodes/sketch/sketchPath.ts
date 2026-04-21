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
 */
export function pointsToPath(points: number[][], zoom = 1): string {
  const stroke = getStroke(points, {
    ...SKETCH_OPTIONS,
    size: SKETCH_OPTIONS.size * zoom,
  });
  return getSvgPathFromStroke(stroke);
}
