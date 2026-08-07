// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/// <reference types="vite/client" />

/**
 * Inlined at build time by Vite (`define`) from the desktop package's
 * version field. See `vite.config.ts`. Available to all client code as
 * a global string literal — no runtime fetch required.
 */
declare const __APP_VERSION__: string;

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
