/**
 * Minimal runtime interfaces for the canvas command executor.
 * Keeps the executor decoupled from the full Zustand store.
 */

import type { Node, Edge } from '@xyflow/react';

/**
 * Domain-level aliases for the canvas graph primitives.
 *
 * The canvas-engine package conceptually owns a graph of nodes and
 * edges. Today both are implemented as `@xyflow/react` `Node` / `Edge`
 * because the web renderer (ReactFlow) consumes them directly, but
 * that's an implementation detail of the host. Engine-internal code
 * should refer to `CanvasNode` / `CanvasEdge` so that headless / server
 * callers (and a future renderer migration) can re-target the alias
 * without touching every handler.
 *
 * Keep the underlying type imported as `import type` only — the engine
 * must not pull `@xyflow/react` runtime code (the package's ESLint
 * rule enforces this).
 */
export type CanvasNode = Node;
export type CanvasEdge = Edge;

/** The minimal state slice that command handlers need to read. */
export interface CanvasReadState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  canvasId: string;
  /**
   * UI preference for "auto-fit frames after edits".
   *
   * Optional: when undefined (e.g. on a headless server caller that has
   * no per-tab UI toggle), the executor treats it as `true` so that
   * structural commands keep frames consistent without the host having
   * to opt in explicitly. Web callers always pass an explicit boolean
   * matching the user's toolbar toggle.
   */
  autoLayoutEnabled?: boolean;
}

/**
 * The result produced by the executor after applying a command batch.
 * The store layer reads these fields to decide what to commit.
 */
export interface CanvasWriteResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Whether the batch needs edge handle recalculation via rerouteAllEdges. */
  requiresEdgeReroute: boolean;
  /**
   * Whether the executor determined an undo snapshot is needed.
   * false when all commands are snapshot:'no' or snapshot:'caller'.
   */
  snapshotNeeded: boolean;
}

/**
 * Accumulated side-effect requests collected during a batch execution.
 * The web caller consumes these via `runPostEffects` after committing
 * the executor's write result to the store. Server-side callers may
 * inspect or persist the metadata however they like.
 */
export interface PendingEffects {
  /** Nodes that need preprocessing (ingestion, label resolution, or both). */
  preprocessNodes: CanvasNode[];
  /** Node IDs that were deleted and need server-side tracking. */
  deletedNodeIds: string[];
  /** Whether layout animation CSS transitions need cleanup after animation. */
  needsTransitionCleanup: boolean;
  /**
   * Frame IDs to re-fit after the next render cycle. Used when a
   * command (e.g. `SET_NODE_GEOMETRY` clearing a pinned height) leaves
   * a child node whose new content height is only known once the DOM
   * has reflowed. De-duplicated by `runPostEffects`.
   *
   * **Web-only semantics.** This field exists because the web renderer
   * (ReactFlow) measures node sizes asynchronously via a `ResizeObserver`,
   * so a synchronous `fitFrames` immediately after the command sees the
   * pre-reflow size. Server-side / headless hosts that don't render to a
   * DOM should ignore `deferredFitFrameIds` — their `fitFrames` pass at
   * end-of-batch is authoritative.
   */
  deferredFitFrameIds: string[];
}
