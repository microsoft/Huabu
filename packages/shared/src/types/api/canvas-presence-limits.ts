// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Bounds and timings of Space presence, shared by the server and the browser.
 * Kept apart from the schemas in `canvas-presence.ts` so the web bundle can
 * import these values without importing zod.
 */
export const CANVAS_PRESENCE_LIMITS = {
  pageIdMaxLength: 64,
  labelMaxLength: 40,
  displayNameMaxLength: 80,
  nodeIdMaxLength: 128,
  /** Per list (selected, dragging, editing). */
  maxNodeIds: 200,
  /** Flow coordinates beyond this magnitude are rejected. */
  maxCoordinate: 10_000_000,
  maxPagesPerSpace: 32,
  /**
   * Pages one principal may have present in a Space (its tabs and devices),
   * so one caller cannot take every place of the Space.
   */
  maxPagesPerPrincipal: 16,
  /** Number of marker colours; `colorIndex` is in `[0, colorCount)`. */
  colorCount: 6,
  /**
   * A page that has not reported for this long is dropped. Longer than a
   * minute because a background tab's timers may fire only once a minute.
   */
  expiryMs: 75_000,
  /** A page repeats its whole state this often to stay present. */
  heartbeatMs: 20_000,
  /** Minimum gap between two reports of one page (browser throttle). */
  reportIntervalMs: 80,
  /** Reports the server accepts from one page per second. */
  maxReportsPerSecond: 30,
  /** Reports the server accepts from one principal, across its pages of a Space, per second. */
  maxReportsPerPrincipalPerSecond: 120,
  /** Reports the server accepts from one network peer per minute. */
  maxReportsPerPeerPerMinute: 3_000,
} as const;
