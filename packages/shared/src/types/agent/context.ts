import type { CanvasNodeType, NodeOrigin } from '../canvas/node.js';

// ==================== Node Reference ====================

/**
 * Lightweight reference to a canvas node.
 * Used in RecentAction to avoid duplicating full NodeSummary data.
 * AI can use `id` to call `read` on "nodes/<nodeId>.md" for full content,
 * or `inspect_nodes({ ids: [<id>] })` for layout / style.
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
 * "focus on this". `SelectionPayload` is the **wire shape** posted by
 * the web client: it can recurse into frame `children` and carries
 * `src` for image nodes (so the server can build vision attachments).
 * Full node content / layout is fetched on demand via `read` /
 * `inspect_nodes`, keeping the request body small.
 *
 * The server flattens this into {@link LlmSelectionRef} entries before
 * handing the selection to the LLM — see `collectSelectedNodeRefs`
 * in the agent route.
 */
export interface SelectionPayload {
  id: string;
  type: CanvasNodeType;
  label?: string;
  /** Source URL for image nodes (used by the server to build vision attachments). */
  src?: string;
  /**
   * Direct children of a frame node, each carrying their own detail.
   * Undefined for non-frame nodes.
   */
  children?: SelectionPayload[];
}

/**
 * Minimal node reference handed to the LLM as selection context.
 *
 * Distinct from {@link SelectionPayload}: that's the wire format
 * sent from the web client (carries `src` for vision + frame
 * `children`); this is the flattened, LLM-facing form built by the
 * agent route. Carries everything the model needs to address a node
 * without further derivation:
 *  - `id`       — stable handle for `inspect_nodes`, `MERGE_NODE_DATA`, etc.
 *  - `label`    — display name (omitted when blank).
 *  - `type`     — `note` / `web` / `pdf` / `image` / `video` / `frame` /
 *                 `text`.
 *  - `filename` — pre-computed `nodes/<safeLabel>.md` path, ready to
 *                 hand straight to `read`. The server derives this so
 *                 the LLM never has to compute `safeLabel` itself
 *                 (a frequent source of bad guesses around spaces and
 *                 special characters). Falls back to `nodes/<id>.md`
 *                 for label-less nodes (e.g. fresh frames).
 */
export interface LlmSelectionRef {
  id: string;
  type: CanvasNodeType;
  label?: string;
  filename: string;
}

/**
 * The base context sent with every agent request.
 * Designed to be lightweight: nodes carry only label + snippet,
 * full content is fetched on demand via `read` on "nodes/<nodeId>.md".
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
   * snapshot.
   */
  selectedNodes: SelectionPayload[];
}
