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
  /** Nodes that need knowledge-base ingestion after commit. */
  ingestNodes?: Node[];
  /** Node IDs that need LLM label resolution after commit. */
  labelResolveNodeIds?: string[];
  /** Node IDs that were deleted and need server-side tracking. */
  deletedNodeIds?: string[];
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
