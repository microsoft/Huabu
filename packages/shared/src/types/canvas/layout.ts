// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas geometry primitives — points, bounds, and viewport.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Pan + zoom of the React Flow viewport. Persisted with Space topology
 * (under `state.viewport`) so the user lands back at the same view
 * when reopening a canvas, and so adding/removing nodes never
 * silently re-fits the canvas.
 */
export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}
