// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Execution-layer types for command batching, validation, undo, and tracing.
 */

import type { CanvasCommand } from './command.js';

export type CanvasExecutionSource = 'ui' | 'agent' | 'system';

/**
 * One logical batch of commands that should validate and commit together.
 */
export interface CanvasExecution {
  /** Defaults to `'ui'` when omitted. */
  source?: CanvasExecutionSource;
  commands: CanvasCommand[];
}

export type CanvasCommandFailureReason =
  | 'no-op'
  | 'not-found'
  | 'invalid-parent'
  | 'invalid-target'
  | 'invalid-scope'
  | 'cycle'
  | 'duplicate-id'
  | 'conflict';

export interface CanvasCommandResult {
  command: CanvasCommand;
  applied: boolean;
  reason?: CanvasCommandFailureReason;
}

/**
 * A rejected content write under optimistic concurrency (compare-and-swap).
 * Returned when an agent `MERGE_NODE_DATA` targets a node whose current
 * authored-content revision no longer matches the rev the writer saw — or
 * when the agent never read the node this run (no `expectRev` at all). The
 * `currentContent` is echoed so the caller can reconcile without a re-read.
 */
export interface ExecuteConflict {
  nodeId: string;
  /**
   * Why the write was rejected. `not-read`: the writer never read this node
   * in the current conversation (no `expectRev` at all) — it MUST `read` the
   * node before writing its content; retrying the same command without a read
   * is rejected identically. `stale`: the writer read an earlier revision that
   * has since changed — re-read, reconcile, and re-issue.
   */
  reason: 'not-read' | 'stale';
  /** Rev the writer expected; absent when it never read the node this run. */
  expectedRev?: string;
  /** The node's actual current authored-content revision. */
  currentRev: string;
  /** The node's current body, echoed for a re-read-free reconcile. */
  currentContent?: string;
}
