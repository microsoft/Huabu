/**
 * Shared canvas command schema executed by both the web client and agent flows.
 */

import type { LayoutStrategy, Point } from './layout.js';
import type { CanvasNodeType, NodeData } from './node.js';
import type { PrefixedId } from '../../utils/id.js';

/**
 * Canvas node ids follow the standard `node-<uuid>` convention.
 */
export type CanvasNodeId = PrefixedId<'node'>;

/**
 * Canvas edge ids follow the standard `edge-<uuid>` convention.
 */
export type CanvasEdgeId = PrefixedId<'edge'>;

/**
 * Explicit edge target used for disconnect commands.
 */
export type CanvasEdgeRef =
  | CanvasEdgeId
  | { source: CanvasNodeId; target: CanvasNodeId };

export interface NodeSize {
  width: number;
  height?: number;
}

export type CanvasAlignDirection =
  | 'left'
  | 'center-h'
  | 'right'
  | 'top'
  | 'center-v'
  | 'bottom';

export type CanvasAutoLayoutScope =
  | { type: 'canvas' }
  | { type: 'frame'; frameId: CanvasNodeId };

export interface CanvasAutoLayoutOptions {
  strategy?: LayoutStrategy;
  spacing?: Partial<NodeSize>;
  animate?: boolean;
}

type CanvasNodeCreateInputByType<T extends CanvasNodeType> = {
  /**
   * Optional explicit id for deterministic callers.
   * If later commands in the same batch need to reference this node,
   * the caller should provide a standard `node-<uuid>` id here.
   */
  id?: CanvasNodeId;
  nodeType: T;
  data?: Partial<Omit<Extract<NodeData, { type: T }>, 'type'>>;
  position?: Point;
  size?: NodeSize;
  parentId?: CanvasNodeId | null;
  /** When true, skip force-directed auto-placement (e.g. node was explicitly placed by drag). */
  skipAutoLayout?: boolean;
};

export type CanvasNodeCreateInput = {
  [T in CanvasNodeType]: CanvasNodeCreateInputByType<T>;
}[CanvasNodeType];

export type CanvasNodeDataMergePatch = {
  nodeId: CanvasNodeId;
  patch: Record<string, unknown>;
};

export interface CanvasNodeParentUpdate {
  nodeIds: CanvasNodeId[];
  parentId: CanvasNodeId | null;
}

export interface CanvasNodeGeometryUpdate {
  nodeId: CanvasNodeId;
  position?: Point;
  size?: NodeSize;
}

export interface CanvasNodeLockUpdate {
  nodeId: CanvasNodeId;
  locked: boolean;
}

export interface CanvasEdgeCreateInput {
  id?: CanvasEdgeId;
  source: CanvasNodeId;
  target: CanvasNodeId;
}

/**
 * Shared executable canvas command schema.
 *
 * Commands are explicit, JSON-serializable, and free of web-only gesture state.
 */
export type CanvasCommand =
  | {
      type: 'CREATE_NODES';
      nodes: CanvasNodeCreateInput[];
    }
  | { type: 'DELETE_NODES'; nodeIds: CanvasNodeId[] }
  | { type: 'MERGE_NODE_DATA'; patches: CanvasNodeDataMergePatch[] }
  | {
      type: 'SET_NODE_PARENT';
      nodeIds: CanvasNodeId[];
      parentId: CanvasNodeId | null;
    }
  | { type: 'DISSOLVE_FRAME'; frameId: CanvasNodeId }
  | { type: 'SET_NODE_GEOMETRY'; items: CanvasNodeGeometryUpdate[] }
  | {
      type: 'REORDER_NODES';
      nodeIds: CanvasNodeId[];
      to: 'top' | 'bottom' | { before: CanvasNodeId } | { after: CanvasNodeId };
    }
  | { type: 'CONNECT_NODES'; edges: CanvasEdgeCreateInput[] }
  | { type: 'DISCONNECT_EDGES'; edges: CanvasEdgeRef[] }
  | {
      type: 'ALIGN_NODES';
      nodeIds: CanvasNodeId[];
      direction: CanvasAlignDirection;
    }
  | {
      type: 'DISTRIBUTE_NODES';
      nodeIds: CanvasNodeId[];
    }
  | {
      type: 'AUTO_LAYOUT';
      scope: CanvasAutoLayoutScope;
      options?: CanvasAutoLayoutOptions;
    }
  | { type: 'SET_NODE_SELECTION'; nodeIds: CanvasNodeId[] }
  | { type: 'SET_EXPANDED_NODE'; nodeId: CanvasNodeId | null }
  | { type: 'SET_NODE_LOCKED'; items: CanvasNodeLockUpdate[] };

export type CanvasCommandType = CanvasCommand['type'];
