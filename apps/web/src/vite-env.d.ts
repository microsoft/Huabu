// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/// <reference types="vite/client" />

/**
 * This build's identity, inlined at build time by Vite (`define`) from
 * `scripts/build-version.mjs`: the desktop package's semver plus the source
 * commit, e.g. `0.9.2+gabc1234`, `0.9.2+gabc1234.dirty` for a modified
 * checkout, or the nightly `0.9.2-nightly.20261120.gabc1234`. Just `0.9.2`
 * when the commit is unknown. A global string literal; no runtime fetch.
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
