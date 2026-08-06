// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { NodeRef } from './node-ref.js';
import type { WireSelectionNode } from '../api/agent.js';

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

// ==================== Agent Chat / Intent contexts ====================

/**
 * Context sent with every chat-agent request (`POST /api/agent`).
 *
 * Deliberately minimal: only the user's **explicit selection** travels
 * with the request. The rest of the canvas (nodes / edges / spatial
 * layout / recent actions / screenshot) is fetched on demand by the
 * agent through tools — `get_canvas_outline`, `inspect_nodes`,
 * `inspect_edges`, `read`, etc. — so we don't pay the upload cost on
 * every turn for data the model usually doesn't need.
 *
 * Selection is the primary intent signal: "focus on this". Wire shape
 * stays raw; the server enriches into `AgentNodeRef[]` before any
 * prompt rendering so the LLM gets the pre-computed
 * `nodes/<safeLabel>.md` filename without web having to apply the
 * safeLabel rule.
 */
export interface AgentChatContext {
  /**
   * Nodes explicitly selected by the user at the time of the request.
   * Empty array means "no explicit selection; the agent should pull
   * canvas state via tools as needed".
   */
  selectedNodes: WireSelectionNode[];
}
