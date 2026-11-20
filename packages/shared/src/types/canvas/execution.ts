// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Execution-layer types for command batching, validation, undo, and tracing.
 */

import type { CanvasCommand } from './command.js';

export type CanvasExecutionSource = 'ui' | 'agent' | 'system';

/**
 * A list of commands run in order, each on its own: a command that does not
 * take effect is skipped and the others still apply. The page's local run
 * and the legacy `{ commands }` request use this; it is the same as
 * {@link CanvasEditsExecution} with one edit per command.
 */
export interface CanvasExecution {
  /** Defaults to `'ui'` when omitted. */
  source?: CanvasExecutionSource;
  commands: CanvasCommand[];
}

/**
 * One edit: the commands of one intent (a gesture, one Agent step). It takes
 * effect as a whole or not at all.
 */
export interface CanvasEdit {
  commands: readonly CanvasCommand[];
  /**
   * Earlier edits of the same execution, by position, whose result this one
   * was made on top of. When one of them did not take effect, neither does
   * this one.
   */
  after?: readonly number[];
  /**
   * The edit was made on top of an edit of an earlier request that did not
   * take effect (or whose outcome is not known); it does not run.
   */
  blocked?: boolean;
}

/** Edits run in order; each sees the state the ones before it left. */
export interface CanvasEditsExecution {
  /** Defaults to `'ui'` when omitted. */
  source?: CanvasExecutionSource;
  edits: readonly CanvasEdit[];
}

export type CanvasCommandFailureReason =
  | 'no-op'
  | 'not-found'
  | 'invalid-parent'
  | 'invalid-target'
  | 'invalid-scope'
  | 'cycle'
  | 'duplicate-id'
  | 'conflict'
  /**
   * Read-version check: a node the command targets no longer exists, or was
   * created after the version the caller read.
   */
  | 'stale-target'
  /**
   * Read-version check: a node the command targets was moved to another
   * parent after the version the caller read.
   */
  | 'stale-parent';

export interface CanvasCommandResult {
  command: CanvasCommand;
  applied: boolean;
  reason?: CanvasCommandFailureReason;
}

/**
 * Whether a command result means the command did not take effect.
 *
 * `no-op` is the one harmless outcome: the command was understood and there
 * was nothing for it to change. Every other result that is not applied — a
 * missing target, an invalid parent, a stale read version, a conflict, a
 * command outside the caller's scope, or no reason at all — is a failure,
 * and fails the edit the command belongs to.
 */
export function isRefusedResult(result: {
  applied: boolean;
  reason?: string | undefined;
}): boolean {
  return !result.applied && result.reason !== 'no-op';
}

/** What became of one {@link CanvasEdit}. */
export interface CanvasEditResult {
  /**
   * The edit took effect: none of its commands failed. (All of them may
   * have been no-ops.) When false, none of its commands is applied.
   */
  applied: boolean;
  /** Why the edit did not take effect. */
  reason?: CanvasCommandFailureReason;
  /**
   * Index, within the edit, of the command that failed. Absent when the
   * edit was refused before its first command ran (a stale read version, an
   * edit it was made on top of that did not take effect).
   */
  failedAt?: number;
  /** One result per command of the edit, in order. */
  results: CanvasCommandResult[];
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
