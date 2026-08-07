// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared types and helpers for per-command definition files.
 *
 * Each command file imports these to define its handler and metadata.
 * This file must NOT import from the command registry (commands/index.ts)
 * to avoid circular dependencies.
 */

import type {
  CanvasCommand,
  CanvasCommandFailureReason,
  CanvasExecutionSource,
} from '../../index.js';
import type { CanvasReadState } from '../interfaces.js';
import type { Node, Edge } from '@xyflow/react';

// ---------------------------------------------------------------------------
// Command metadata
// ---------------------------------------------------------------------------

export interface CommandMeta {
  snapshot: 'yes' | 'caller' | 'no';
  requiresEdgeReroute: boolean;
}

// ---------------------------------------------------------------------------
// Command handler result & type
// ---------------------------------------------------------------------------

export interface CommandHandlerResult {
  applied: boolean;
  reason?: CanvasCommandFailureReason;
  nodes: Node[];
  edges: Edge[];
  /**
   * Nodes created or mutated by this command — forwarded to the host
   * as candidates for preprocessing. The engine never filters by
   * node type / watched fields; that's the server's job.
   */
  mutatedNodes?: Node[];
  /** Node IDs that were deleted and need server-side tracking. */
  deletedNodeIds?: string[];
  /**
   * Node IDs whose `content` field was just rewritten. Pure fact —
   * the engine has no notion of "AI authored". Web hosts decide,
   * based on the batch source, whether to flag these as AI rewrites
   * (see `runWebPostEffects`). Today only `MERGE_NODE_DATA` populates
   * this; future content-rewriting commands should follow suit.
   */
  contentEditedNodeIds?: string[];
  /**
   * Parent frame IDs whose children's geometry changed in this command.
   * Handlers no longer call `fitFrames` themselves — they only declare
   * which frames are affected, and the executor performs a single
   * synchronous `fitFrames` pass at the end of the batch. The pass is
   * filtered per-frame by `data.sizing` (`'hug'` participates, `'manual'`
   * is skipped); `options.forceFitFrames` (set for agent batches)
   * bypasses the per-frame filter.
   */
  affectedFrameIds?: string[];
  /** Portal IDs whose direct nodeRef children changed geometry or membership. */
  affectedPortalIds?: string[];
  /**
   * Frame IDs whose children's rendered size will only stabilise after
   * the next render cycle (e.g. clearing a pinned height to revert to
   * content-driven sizing). The web post-effect drain schedules a
   * deferred refit of these frames once the DOM has reflowed.
   * **Web-only semantics** — server-side hosts of the executor can
   * ignore this field.
   */
  deferredFitFrameIds?: string[];
}

export interface CommandHandlerContext extends CanvasReadState {
  source: CanvasExecutionSource;
}

export type CommandHandler<T extends CanvasCommand = CanvasCommand> = (
  cmd: T,
  state: CommandHandlerContext,
) => CommandHandlerResult;

// ---------------------------------------------------------------------------
// Per-command definition (handler + meta co-located)
// ---------------------------------------------------------------------------

export interface CommandDefinition<T extends CanvasCommand = CanvasCommand> {
  meta: CommandMeta;
  handler: CommandHandler<T>;
}

// ---------------------------------------------------------------------------
// Helper: build a no-op (not-applied) result from the current state.
// ---------------------------------------------------------------------------

export function noop(
  state: CanvasReadState,
  reason: CanvasCommandFailureReason = 'no-op',
): CommandHandlerResult {
  return { applied: false, reason, nodes: state.nodes, edges: state.edges };
}
