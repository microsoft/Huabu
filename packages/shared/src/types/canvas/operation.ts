/**
 * Canvas Operation Types
 * Programmatic canvas manipulation (used by research graph)
 */

import type { EdgeStyle } from './edge.js';
import type { Point } from './layout.js';
import type { NodeData, FrameNodeData } from './node.js';

export interface CreateNodeParams {
  canvasId: string;
  position: Point;
  /** Complete node data including type and all fields */
  data: NodeData;
  /** Optional: explicit width/height */
  size?: { width: number; height: number };
}

export interface CreateNodeResult {
  nodeId: string;
}

export interface CreateFrameParams {
  canvasId: string;
  label: string;
  position: Point;
  /** Node IDs to wrap in this frame */
  childNodeIds: string[];
  /** Optional frame data */
  data?: Partial<FrameNodeData>;
  /** Optional: explicit size (otherwise auto-calculated) */
  size?: { width: number; height: number };
}

export interface CreateEdgeParams {
  canvasId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  style?: EdgeStyle;
}

export interface CreateEdgeResult {
  edgeId: string;
}
