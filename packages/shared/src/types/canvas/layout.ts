/**
 * Canvas CanvasPage Types
 * CanvasPage calculation and positioning
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
 * Pan + zoom of the React Flow viewport. Persisted in `canvas.json`
 * (under `state.viewport`) so the user lands back at the same view
 * when reopening a canvas, and so adding/removing nodes never
 * silently re-fits the canvas.
 */
export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export type LayoutStrategy = 'hierarchical' | 'radial' | 'force-directed';

export interface LayoutConfig {
  strategy: LayoutStrategy;
  spacing: { x: number; y: number };
}

export type PlacementStrategy = 'right' | 'bottom' | 'empty-space' | 'auto';

export interface CalculateLayoutParams {
  canvasId: string;
  /** Existing canvas bounds */
  existingBounds?: Bounds;
  /** Placement strategy */
  placementStrategy: PlacementStrategy;
  /** Number of new nodes to place */
  nodeCount: number;
  /** Padding from existing content */
  padding?: number;
}

export interface LayoutResult {
  /** Starting position for the first node */
  startPosition: Point;
  /** Suggested positions for all nodes (if layout is pre-calculated) */
  positions?: Point[];
}
