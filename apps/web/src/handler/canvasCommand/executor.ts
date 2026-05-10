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
import { fitFrames, type NestableNode } from './utils/frame';

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
    preprocessNodes: [],
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
  const agentAffectedFrameIds = new Set<string>();

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
    const handler = HANDLERS[cmd.type as keyof typeof HANDLERS] as
      | ((cmd: CanvasCommand, state: CanvasReadState) => CommandHandlerResult)
      | undefined;

    // Defensive guard: skip commands with no registered handler so a
    // hallucinated / out-of-schema type from an upstream source (e.g. an
    // LLM) doesn't crash the whole batch. Record as not-applied so the
    // caller can surface the failure instead of silently dropping it.
    if (!handler) {
      console.warn(
        '[canvas-executor] Unknown command type — skipping:',
        cmd.type,
        cmd,
      );
      commandResults.push({ command: cmd, applied: false, reason: 'no-op' });
      continue;
    }

    if (execution.source === 'agent') {
      if (cmd.type === 'CREATE_NODES') {
        for (const node of cmd.nodes) {
          if (node.nodeType === 'frame' && node.id) {
            agentAffectedFrameIds.add(node.id as string);
          }
          if (node.parentId) {
            agentAffectedFrameIds.add(node.parentId as string);
          }
        }
      } else if (cmd.type === 'SET_NODE_GEOMETRY') {
        for (const item of cmd.items) {
          const node = currentNodes.find((n) => n.id === item.nodeId);
          if (node?.parentId) {
            agentAffectedFrameIds.add(node.parentId);
          }
        }
      } else if (cmd.type === 'SET_NODE_PARENT') {
        if (cmd.parentId) {
          agentAffectedFrameIds.add(cmd.parentId as string);
        }
        for (const nodeId of cmd.nodeIds) {
          const node = currentNodes.find((n) => n.id === nodeId);
          if (node?.parentId) {
            agentAffectedFrameIds.add(node.parentId);
          }
        }
      } else if (cmd.type === 'DELETE_NODES') {
        const removedIds = new Set(cmd.nodeIds as string[]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const node of currentNodes) {
            if (
              node.parentId &&
              removedIds.has(node.parentId) &&
              !removedIds.has(node.id)
            ) {
              removedIds.add(node.id);
              changed = true;
            }
          }
        }

        for (const node of currentNodes) {
          if (
            removedIds.has(node.id) &&
            node.parentId &&
            !removedIds.has(node.parentId)
          ) {
            agentAffectedFrameIds.add(node.parentId);
          }
        }
      } else if (cmd.type === 'DISSOLVE_FRAME') {
        const frame = currentNodes.find((n) => n.id === cmd.frameId);
        if (frame?.parentId) {
          agentAffectedFrameIds.add(frame.parentId);
        }
      } else if (cmd.type === 'CREATE_QUESTION') {
        if (cmd.parentId) {
          agentAffectedFrameIds.add(cmd.parentId as string);
        }
      }
    }

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
      if (result.preprocessNodes) {
        pendingEffects.preprocessNodes.push(...result.preprocessNodes);
      }
      if (result.deletedNodeIds) {
        pendingEffects.deletedNodeIds.push(...result.deletedNodeIds);
      }
    }
  }

  // ------------------------------------------------------------------
  // Agent-sourced frame auto-fit.
  //
  // The LLM cannot accurately predict rendered frame dimensions, so we
  // unconditionally fit affected parent frames after an agent batch
  // (regardless of autoLayoutEnabled).  Individual handlers already fit
  // frames when autoLayoutEnabled is true — the second pass is a no-op
  // in that case.
  // ------------------------------------------------------------------
  if (execution.source === 'agent' && anyApplied) {
    if (agentAffectedFrameIds.size > 0) {
      currentNodes = fitFrames(
        currentNodes as NestableNode[],
        agentAffectedFrameIds,
      );
    }
  }

  // ------------------------------------------------------------------
  // Derive batch-level metadata from COMMAND_META.
  // ------------------------------------------------------------------

  // Snapshot is needed if any command in the batch has snapshot:'yes'
  // and the execution doesn't declare caller-handled snapshots.
  // (Optional chaining tolerates unknown command types skipped above.)
  const snapshotNeeded =
    anyApplied &&
    execution.commands.some((c) => COMMAND_META[c.type]?.snapshot === 'yes');

  // Edge reroute is needed if any *applied* command requires it.
  const requiresEdgeReroute = execution.commands.some(
    (c, i) =>
      commandResults[i]?.applied && COMMAND_META[c.type]?.requiresEdgeReroute,
  );

  // Transition cleanup is needed if any *applied* command declares it.
  const needsTransitionCleanup = execution.commands.some(
    (c, i) =>
      commandResults[i]?.applied &&
      COMMAND_META[c.type]?.needsTransitionCleanup,
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
