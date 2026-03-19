/**
 * Minimal runtime interfaces for the canvas command executor.
 * Keeps the executor decoupled from the full Zustand store.
 */

import type { Node, Edge } from '@xyflow/react';

/** The minimal state slice that command handlers need to read. */
export interface CanvasReadState {
  nodes: Node[];
  edges: Edge[];
  canvasId: string;
  autoLayoutEnabled: boolean;
}

/**
 * The result produced by the executor after applying a command batch.
 * The store layer reads these fields to decide what to commit.
 */
export interface CanvasWriteResult {
  nodes: Node[];
  edges: Edge[];
  /** SET_EXPANDED_NODE is handled inline by the executor. */
  expandedNodeId?: string | null;
  /** Whether the batch needs edge handle recalculation via rerouteAllEdges. */
  requiresEdgeReroute: boolean;
  /**
   * Whether the executor determined an undo snapshot is needed.
   * false when all commands are snapshot:'no' or snapshot:'caller'.
   */
  snapshotNeeded: boolean;
}

/** Post-commit side-effect callbacks provided by the store. */
export interface CanvasEffectCallbacks {
  triggerIngestion: (node: Node) => void;
  triggerLabelResolve: (nodeId: string) => void;
}
