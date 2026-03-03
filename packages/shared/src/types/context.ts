import type { CanvasNodeType } from './canvas/node.js';

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
}

// ==================== Recent Actions ====================

/**
 * Discriminated union of canvas actions.
 * Each action type carries only the fields relevant to it.
 *
 * Note: `nodes_deleted` carries optional snippets because the nodes
 * will no longer appear in `nodes[]` after deletion.
 */
export type RecentAction =
  | { action: 'node_created'; node: NodeRef }
  | { action: 'nodes_deleted'; nodes: Array<NodeRef & { snippet?: string }> }
  | { action: 'node_edited'; node: NodeRef }
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
  | { action: 'nodes_pasted'; nodes: NodeRef[] }
  | { action: 'nodes_moved'; nodes: NodeRef[] };

// ==================== Canvas Snapshot ====================

/**
 * Lightweight summary of a canvas node injected into the agent context.
 * `snippet` is the first ~120 chars of plain-text content (or src for web/pdf).
 * `sourceId` is set when the node has been ingested into the knowledge base.
 */
export interface NodeSummary {
  id: string;
  type: CanvasNodeType;
  label?: string;
  /** First ~120 chars of plain-text content; src URL for web/pdf/video/image nodes */
  snippet?: string;
  selected: boolean;
  /** Label of the parent frame, if any */
  frameLabel?: string;
  /** Knowledge base source ID — present when the node has been ingested */
  sourceId?: string;
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
}
