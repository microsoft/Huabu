/**
 * Batch executor for canvas commands.
 *
 * Processes a `CanvasExecution` (one or more commands) against the current
 * canvas state, returning the new state and accumulated side-effect metadata.
 *
 * Responsibilities:
 * - Sequential command execution within a batch (each command sees the
 *   previous command's result state).
 * - SET_EXPANDED_NODE is handled inline (doesn't go through the handler
 *   registry since it only modifies a scalar, not nodes/edges).
 * - Uses COMMAND_META to determine snapshot policy and edge reroute needs.
 * - Collects action trace entries and pending effects from all commands.
 *
 * Does NOT:
 * - Call set() on the store.
 * - Take undo snapshots (signals via `snapshotNeeded` instead).
 * - Run post-commit side effects (the store layer does that with
 *   `runPostEffects`).
 */

import { HANDLERS, COMMAND_META, type CommandHandlerResult } from './commands';

import type { PendingEffects } from './postEffects';
import type { CanvasReadState, CanvasWriteResult } from './runtime';
import type {
  CanvasCommand,
  CanvasExecution,
  CanvasCommandResult,
} from '@sediment/shared';

export interface ExecutorOutput {
  writeResult: CanvasWriteResult;
  commandResults: CanvasCommandResult[];
  /** Accumulated side-effect requests for `runPostEffects`. */
  pendingEffects: PendingEffects;
}

/**
 * Execute a batch of canvas commands against the given state.
 *
 * Returns the new nodes/edges, execution metadata, and accumulated
 * side-effect requests. The caller (store layer) is responsible for:
 * 1. Committing the write result to Zustand state.
 * 2. Taking an undo snapshot if `writeResult.snapshotNeeded` is true.
 * 3. Calling `runPostEffects` with the pending effects.
 */
export function executeCanvasCommands(
  execution: CanvasExecution,
  state: CanvasReadState,
): ExecutorOutput {
  // Mutable accumulators — built up as commands are processed.
  const commandResults: CanvasCommandResult[] = [];
  const pendingEffects: PendingEffects = {
    ingestNodes: [],
    labelResolveNodeIds: [],
    deletedNodeIds: [],
    needsTransitionCleanup: false,
  };

  // Evolving state that each command reads from / writes to.
  let currentNodes = state.nodes;
  let currentEdges = state.edges;

  // SET_EXPANDED_NODE result (if any).
  let expandedNodeId: string | null | undefined;

  // Track which commands were actually applied.
  let anyApplied = false;

  for (const cmd of execution.commands) {
    // ------------------------------------------------------------------
    // SET_EXPANDED_NODE — inline handling (no handler registry).
    // ------------------------------------------------------------------
    if (cmd.type === 'SET_EXPANDED_NODE') {
      expandedNodeId = (cmd.nodeId as string) ?? null;
      commandResults.push({ command: cmd, applied: true });
      anyApplied = true;
      continue;
    }

    // ------------------------------------------------------------------
    // All other commands — dispatch to the handler registry.
    // ------------------------------------------------------------------
    const handler = HANDLERS[cmd.type] as (
      cmd: CanvasCommand,
      state: CanvasReadState,
    ) => CommandHandlerResult;

    const result = handler(cmd, {
      nodes: currentNodes,
      edges: currentEdges,
      canvasId: state.canvasId,
      autoLayoutEnabled: state.autoLayoutEnabled,
    });

    // Record the command result.
    commandResults.push({
      command: cmd,
      applied: result.applied,
      reason: result.reason,
    });

    if (result.applied) {
      anyApplied = true;

      // Advance the evolving state so the next command in the batch
      // sees this command's changes.
      currentNodes = result.nodes;
      currentEdges = result.edges;

      // Collect pending effects.
      if (result.ingestNodes) {
        pendingEffects.ingestNodes.push(...result.ingestNodes);
      }
      if (result.labelResolveNodeIds) {
        pendingEffects.labelResolveNodeIds.push(...result.labelResolveNodeIds);
      }
      if (result.deletedNodeIds) {
        pendingEffects.deletedNodeIds.push(...result.deletedNodeIds);
      }
    }
  }

  // ------------------------------------------------------------------
  // Derive batch-level metadata from COMMAND_META.
  // ------------------------------------------------------------------

  // Snapshot is needed if any command in the batch has snapshot:'yes'
  // and the execution doesn't declare caller-handled snapshots.
  const snapshotNeeded =
    anyApplied &&
    execution.commands.some((c) => COMMAND_META[c.type].snapshot === 'yes');

  // Edge reroute is needed if any *applied* command requires it.
  const requiresEdgeReroute = execution.commands.some(
    (c, i) =>
      commandResults[i]?.applied && COMMAND_META[c.type].requiresEdgeReroute,
  );

  // Transition cleanup is needed if any *applied* command declares it.
  const needsTransitionCleanup = execution.commands.some(
    (c, i) =>
      commandResults[i]?.applied && COMMAND_META[c.type].needsTransitionCleanup,
  );

  // Set the derived flag on pendingEffects.
  pendingEffects.needsTransitionCleanup = needsTransitionCleanup;

  return {
    writeResult: {
      nodes: currentNodes,
      edges: currentEdges,
      expandedNodeId,
      requiresEdgeReroute,
      snapshotNeeded,
    },
    commandResults,
    pendingEffects,
  };
}
