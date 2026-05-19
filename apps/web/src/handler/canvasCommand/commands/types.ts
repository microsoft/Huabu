/**
 * Shared types and helpers for per-command definition files.
 *
 * Each command file imports these to define its handler and metadata.
 * This file must NOT import from the command registry (commands/index.ts)
 * to avoid circular dependencies.
 */

import type { CanvasReadState } from '../runtime';
import type {
  CanvasCommand,
  CanvasCommandFailureReason,
} from '@sediment/shared';
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
   * Frame IDs whose children's rendered size will only stabilise after
   * the next render cycle (e.g. clearing a pinned height to revert to
   * content-driven sizing). `runPostEffects` schedules a deferred refit
   * of these frames once the DOM has reflowed.
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

/**
 * Metadata-only definition for commands handled inline by the executor
 * (e.g. SET_EXPANDED_NODE).
 */
export interface MetaOnlyDefinition {
  meta: CommandMeta;
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
