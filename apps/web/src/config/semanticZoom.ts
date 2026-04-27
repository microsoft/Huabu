/**
 * Semantic Zoom configuration.
 *
 * Controls when heavy node types switch from full rendering to a
 * lightweight placeholder based on their screen-space width.
 *
 * To add a new LOD level (e.g. 'summary'):
 *   1. Add it to ZoomLOD
 *   2. Add a threshold in screenThresholds
 *   3. Map it in nodeLOD for the relevant node types
 *   4. Handle it in NodeWrapper (render the appropriate component)
 */

/** LOD levels — extensible. Currently only 'full' and 'minimal' are used. */
export type ZoomLOD = 'full' | 'minimal';

/**
 * What to render for a given node type at a given LOD.
 * 'full' = original component, 'minimal' = icon + label placeholder.
 */
export type LODRenderMode = 'full' | 'minimal';

export interface SemanticZoomConfig {
  /** Screen-space width thresholds in pixels (descending order) */
  screenThresholds: Partial<Record<Exclude<ZoomLOD, 'full'>, number>>;
  /** Hysteresis buffer in pixels to prevent rapid LOD toggling */
  hysteresis: number;
  /**
   * Per-node-type render mode at each LOD level.
   * Node types not listed here always render 'full'.
   */
  nodeLOD: Record<string, Partial<Record<ZoomLOD, LODRenderMode>>>;
}

export const SEMANTIC_ZOOM_CONFIG: SemanticZoomConfig = {
  screenThresholds: {
    minimal: 200,
  },
  hysteresis: 10,

  nodeLOD: {
    // Only heavy node types — all others default to 'full' at every level.
    note: { full: 'full', minimal: 'minimal' },
    pdf: { full: 'full', minimal: 'minimal' },
    web: { full: 'full', minimal: 'minimal' },
  },
};
