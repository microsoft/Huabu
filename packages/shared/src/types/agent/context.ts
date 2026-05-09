import type { SpatialSummary } from '../../utils/spatial.js';
import type { CanvasNodeType, NodeOrigin } from '../canvas/node.js';

// ==================== Node Reference ====================

/**
 * Lightweight reference to a canvas node.
 * Used in RecentAction to avoid duplicating full NodeSummary data.
 * AI can use `id` to call get_node_content tool for full content.
 */
export interface NodeRef {
  id: string;
  nodeType: CanvasNodeType;
  label?: string;
  /** How this node came to exist — helps the agent understand user intent. */
  origin?: NodeOrigin;
}

// ==================== Recent Actions ====================

/**
 * Coarse classification of a text edit, derived purely from before/after
 * string comparison (no LCS). Lets the agent reason about *what kind*
 * of edit happened ("appending evidence" vs "trimming filler" vs
 * "rewriting the whole thing") without needing the actual diff content.
 *
 * Computed in `computeNodeEditDiff` — see that helper for the rules.
 */
export type NodeEditOp =
  | 'create' // before was empty
  | 'clear' // after is empty
  | 'append' // after starts with before; new chars at the tail
  | 'prepend' // after ends with before; new chars at the head
  | 'insert' // before is a substring of after, but neither prefix nor suffix
  | 'trim' // after is a substring of before (significant deletion)
  | 'trim_tail' // before starts with after; chars removed from the tail
  | 'tweak' // length changed by < 20% and none of the above matched
  | 'rewrite'; // large divergence; treat as a fresh draft

/**
 * Structured summary of a `node_edited` change. Carries no body text on
 * purpose: the action log preserves the existing privacy boundary
 * (only `NodeRef` + structural metrics, no node content).
 *
 * Fields:
 *  - `op`           — see `NodeEditOp`
 *  - `beforeLen`    — character length before the edit
 *  - `afterLen`     — character length after the edit
 *  - `charsAdded`   — `max(0, afterLen - beforeLen)` (lower-bound estimate)
 *  - `charsRemoved` — `max(0, beforeLen - afterLen)` (lower-bound estimate)
 *
 * Net length change is `afterLen - beforeLen`. We deliberately do not
 * report a true edit distance to keep the log cheap and keep payloads
 * stable across editor implementations.
 */
export interface NodeEditDiff {
  op: NodeEditOp;
  beforeLen: number;
  afterLen: number;
  charsAdded: number;
  charsRemoved: number;
}

/**
 * Discriminated union of canvas actions.
 * Each action type carries only the fields relevant to it.
 *
 * Note: `nodes_deleted` carries optional snippets because the nodes
 * will no longer appear in `nodes[]` after deletion.
 */
export type RecentAction =
  | {
      action: 'node_created';
      /** All nodes created in this single operation (1 for ADD_NODE, N for PASTE_NODES). */
      nodes: NodeRef[];
    }
  | { action: 'nodes_deleted'; nodes: Array<NodeRef & { snippet?: string }> }
  | { action: 'node_edited'; node: NodeRef; edit?: NodeEditDiff }
  | { action: 'node_selected'; node: NodeRef }
  | { action: 'nodes_selected'; nodes: NodeRef[] }
  | { action: 'node_expanded'; node: NodeRef }
  | { action: 'node_connected'; source: NodeRef; target: NodeRef }
  | {
      action: 'edges_disconnected';
      edges: Array<{ source: NodeRef; target: NodeRef }>;
    }
  | { action: 'node_framed'; node: NodeRef; frame: NodeRef }
  | { action: 'node_unframed'; node: NodeRef; frame: NodeRef }
  | { action: 'frame_unframed'; frame: NodeRef; nodes: NodeRef[] }
  | { action: 'node_resized'; node: NodeRef; width: number; height: number }
  | { action: 'nodes_reordered'; nodes: NodeRef[] }
  | { action: 'nodes_moved'; nodes: NodeRef[] }
  | { action: 'canvas_undone' }
  | { action: 'canvas_redone' };

// ==================== Canvas Snapshot ====================

/**
 * Lightweight summary of a canvas node injected into the agent context.
 * `snippet` is the first ~120 chars of plain-text content (or src for web/pdf).
 */
export interface NodeSummary {
  id: string;
  type: CanvasNodeType;
  label?: string;
  /** First ~120 chars of plain-text content; src URL for web/pdf/video/image nodes */
  snippet?: string;
  /** Label of the parent frame, if any */
  frameLabel?: string;
  /** Absolute position on canvas (top-left corner). */
  position?: { x: number; y: number };
  /** Measured or styled dimensions. */
  size?: { width: number; height: number };
}

// ==================== Selected Nodes ====================

/**
 * Rich representation of a node explicitly selected by the user.
 *
 * Selection is a strong intent signal — the user is telling the agent
 * "focus on this". `SelectedNodeDetail` carries lightweight metadata only;
 * full node content is fetched on demand via the `get_node_detail` tool to
 * keep the base context small.
 *
 * For frame nodes, `children` contains the detail of every direct child,
 * so the agent understands the entire group the user is referring to.
 */
export interface SelectedNodeDetail {
  id: string;
  type: CanvasNodeType;
  label?: string;
  origin?: NodeOrigin;
  /** Source URL for image nodes (used by the server to build vision attachments). */
  src?: string;
  /**
   * Direct children of a frame node, each carrying their own detail.
   * Undefined for non-frame nodes.
   */
  children?: SelectedNodeDetail[];
  /** Absolute position on canvas (top-left corner). */
  position?: { x: number; y: number };
  /** Measured or styled dimensions. */
  size?: { width: number; height: number };
}

/**
 * The base context sent with every agent request.
 * Designed to be lightweight: nodes carry only label + snippet,
 * full content is fetched on demand via the get_node_content tool.
 */
export interface AgentBaseContext {
  /** Snapshot of all current canvas nodes */
  nodes: NodeSummary[];
  /** Semantic edges between nodes (label pairs, no coordinates) */
  edges: Array<{ source: NodeRef; target: NodeRef }>;
  /**
   * Ring buffer of the last ~10 user actions (maintained by the frontend).
   * Ordered from oldest to newest.
   */
  recentActions: RecentAction[];
  /**
   * Base64-encoded PNG screenshot of the current canvas viewport.
   * Optional — captured on-demand (e.g. intent recognition) for visual reasoning.
   */
  screenshot?: string;
  /**
   * Nodes explicitly selected by the user at the time of the request.
   *
   * Selection is the primary intent signal — it overrides the general canvas
   * snapshot. Each entry carries full content (no truncation) and, for frame
   * nodes, a recursive `children` array so the agent sees the entire group.
   *
   * Empty array means "no explicit selection; use the full canvas as context".
   */
  selectedNodes: SelectedNodeDetail[];
  /**
   * Pre-computed spatial summary of the canvas layout.
   * Contains clusters (groups of nearby nodes) with their arrangement
   * patterns and isolated nodes. Used to give the AI spatial awareness
   * without it having to reason about raw coordinates.
   */
  spatialSummary?: SpatialSummary;
}
