/**
 * @file Layout type definitions.
 *
 * UI-framework-agnostic types consumed by the layout engine.
 * These types intentionally have no dependency on ReactFlow or any
 * other rendering library so the layout module can be tested in isolation.
 */

// ── Layout graph primitives ────────────────────────────────────────────

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
  position: { x: number; y: number };
  /** When true the node must not be repositioned (incremental mode). */
  fixed: boolean;
}

export interface LayoutEdge {
  source: string;
  target: string;
  /** Affinity weight — higher means nodes should be placed closer. [0, 1] */
  weight: number;
}

export interface LayoutGroup {
  /** Frame node id */
  id: string;
  /** Direct child node/group ids */
  children: string[];
  padding: number;
}

/** The complete graph handed to the layout engine. */
export interface LayoutGraph {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  groups: LayoutGroup[];
}

// ── Layout options & result ────────────────────────────────────────────

export interface LayoutOptions {
  /** Minimum gap between sibling nodes */
  nodeSpacing: number;
  /** Gap between top-level groups */
  groupSpacing: number;
  /** Internal padding inside groups */
  groupPadding: number;
}

export interface LayoutResult {
  /** New positions keyed by node id. */
  positions: Map<string, { x: number; y: number }>;
  /** Computed group sizes after layout (used to resize frames). */
  groupSizes: Map<string, { width: number; height: number }>;
}
