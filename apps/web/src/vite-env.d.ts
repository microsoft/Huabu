/// <reference types="vite/client" />

declare module 'simplify-js' {
  interface SimplifyPoint {
    x: number;
    y: number;
  }
  /**
   * Ramer-Douglas-Peucker (and optional radial-distance) polyline simplifier.
   * @param points Input polyline points
   * @param tolerance Maximum allowed distance between simplified and original
   * @param highQuality When true, runs the slower but more accurate RDP-only mode
   */
  function simplify<T extends SimplifyPoint>(
    points: T[],
    tolerance?: number,
    highQuality?: boolean,
  ): T[];
  export default simplify;
}
