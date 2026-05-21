/**
 * Shared types and helpers for per-command definition files.
 *
 * Each command file imports these to define its handler and metadata.
 * This file must NOT import from the command registry (commands/index.ts)
 * to avoid circular dependencies.
 */

import type { CanvasCommand, CanvasCommandFailureReason } from '../../index.js';
import type { CanvasReadState } from '../runtime.js';
import type { Node, Edge } from '@xyflow/react';

// ---------------------------------------------------------------------------
// Command metadata
// ---------------------------------------------------------------------------

export interface CommandMeta {
  snapshot: 'yes' | 'caller' | 'no';
  requiresEdgeReroute: boolean;
  needsTransitionCleanup: boolean;
}

// ---------------------------------------------------------------------------
// Command handler result & type
// ---------------------------------------------------------------------------

export interface CommandHandlerResult {
  applied: boolean;
  reason?: CanvasCommandFailureReason;
  nodes: Node[];
  edges: Edge[];
  /** Nodes that need preprocessing after commit. */
  preprocessNodes?: Node[];
  /** Node IDs that were deleted and need server-side tracking. */
  deletedNodeIds?: string[];
  /**
   * Parent frame IDs whose children's geometry changed in this command.
   * Handlers no longer call `fitFrames` themselves — they only declare
   * which frames are affected, and the executor performs a single
   * synchronous `fitFrames` pass at the end of the batch (gated by
   * `state.autoLayoutEnabled` or the caller's `forceFitFrames` option).
   * This keeps the fit policy in one place and avoids redundant passes.
   */
  affectedFrameIds?: string[];
  /**
   * Frame IDs whose children's rendered size will only stabilise after
   * the next render cycle (e.g. clearing a pinned height to revert to
   * content-driven sizing). `runPostEffects` schedules a deferred refit
   * of these frames once the DOM has reflowed. **Web-only semantics** —
   * server-side hosts of the executor can ignore this field.
   */
  deferredFitFrameIds?: string[];
}

export type CommandHandler<T extends CanvasCommand = CanvasCommand> = (
  cmd: T,
  state: CanvasReadState,
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
