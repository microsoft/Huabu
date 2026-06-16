/**
 * Batch executor for canvas commands.
 *
 * Processes a `CanvasExecution` (one or more commands) against the current
 * canvas state, returning the new state and accumulated side-effect metadata.
 *
 * Responsibilities:
 * - Sequential command execution within a batch (each command sees the
 *   previous command's result state).
 * - Collects affected parent frame IDs from each handler and performs a
 *   single end-of-batch `fitFrames` pass (gated by `autoLayoutEnabled`
 *   or the caller's `forceFitFrames` option). Handlers no longer fit
 *   frames themselves — they only declare which frames are affected.
 * - Uses COMMAND_META to determine snapshot policy and edge reroute needs.
 * - Collects pending effects from all commands.
 *
 * Source-agnostic: behaviour does not depend on `execution.source`. The
 * caller decides whether to force a frame fit (e.g. when applying agent
 * commands that may have unrealistic geometries) via the options arg.
 *
 * Does NOT:
 * - Call set() on the store.
 * - Take undo snapshots (signals via `snapshotNeeded` instead).
 * - Run post-commit side effects (the host layer drains the returned
 *   `pendingEffects` manifest via `applySharedPostEffects` plus a
 *   host-specific drain — see `runWebPostEffects`).
 */

import { applyStructuredFrameRelayout } from './autoLayout/gridLayout.js';
import { HANDLERS, COMMAND_META } from './commands/index.js';
import { fitFrames, type NestableNode } from './frame/index.js';

import type {
  CanvasReadState,
  CanvasWriteResult,
  PendingEffects,
} from './interfaces.js';
import type {
  CanvasCommand,
  CanvasExecution,
  CanvasCommandResult,
} from '../index.js';
import type { CommandHandler } from './commands/index.js';

export interface ExecutorOptions {
  /**
   * When true, run a final `fitFrames` pass over all affected parent
   * frames even if `state.autoLayoutEnabled` is false. The web caller
   * sets this for agent-sourced batches because LLMs cannot accurately
   * predict rendered frame dimensions, so frames must always be sized
   * to fit their children regardless of the user's auto-layout setting.
   */
  forceFitFrames?: boolean;
}

export interface ExecutorOutput {
  writeResult: CanvasWriteResult;
  commandResults: CanvasCommandResult[];
  /**
   * Pure side-effect manifest for host-specific drains. See
   * `applySharedPostEffects` (pure cleanups both hosts run) and
   * `runWebPostEffects` (web-only verbs).
   */
  pendingEffects: PendingEffects;
}

/**
 * Execute a batch of canvas commands against the given state.
 *
 * Returns the new nodes/edges, execution metadata, and accumulated
 * side-effect requests. The caller (host layer) is responsible for:
 * 1. Committing the write result to its state store.
 * 2. Taking an undo snapshot if `writeResult.snapshotNeeded` is true.
 * 3. Running `applySharedPostEffects` for pure cleanups.
 * 4. Draining `pendingEffects` via the host-specific post-effect runner
 *    (`runWebPostEffects` on web; M2 will add a server counterpart).
 */
export function executeCanvasCommands(
  execution: CanvasExecution,
  state: CanvasReadState,
  options: ExecutorOptions = {},
): ExecutorOutput {
  // Mutable accumulators — built up as commands are processed.
  const commandResults: CanvasCommandResult[] = [];
  const pendingEffects: PendingEffects = {
    mutatedNodes: [],
    deletedNodeIds: [],
    contentEditedNodeIds: [],
    deferredFitFrameIds: [],
  };

  // Evolving state that each command reads from / writes to.
  let currentNodes = state.nodes;
  let currentEdges = state.edges;

  // TODO(headless): `state.autoLayoutEnabled` is optional on the type so
  // headless callers can omit it. Today we still propagate the raw value
  // (undefined → falsy → auto-layout off). Once the headless executor
  // wiring lands, normalise to `state.autoLayoutEnabled ?? true` here so
  // server-side runs default to auto-layout on without requiring callers
  // to pass a flag.

  // Aggregated parent frame IDs to refit at the end of the batch.
  const allAffectedFrameIds = new Set<string>();

  // Frames whose track count was explicitly (re)set this batch (via
  // `SET_FRAME_LAYOUT`). These use the `'fill'` empty-track policy so the
  // structured relayout spreads children to occupy every requested track;
  // all other affected frames `'compact'` away tracks emptied by organic
  // child changes (deletions, drags).
  const fillFrameIds = new Set<string>();

  // Track which commands were actually applied.
  let anyApplied = false;

  for (const cmd of execution.commands) {
    // ------------------------------------------------------------------
    // Dispatch to the handler registry. The HANDLERS table is exhaustive
    // over `CanvasCommandType`, so an unknown command type is a
    // TypeScript error — no defensive runtime guard needed.
    // The cast widens the per-type handler back to a uniform shape so
    // we can call it with the union-typed `cmd`.
    // ------------------------------------------------------------------
    const handler = HANDLERS[
      cmd.type as keyof typeof HANDLERS
    ] as CommandHandler<CanvasCommand>;

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
      if (result.mutatedNodes) {
        pendingEffects.mutatedNodes.push(...result.mutatedNodes);
      }
      if (result.deletedNodeIds) {
        pendingEffects.deletedNodeIds.push(...result.deletedNodeIds);
      }
      if (result.contentEditedNodeIds) {
        pendingEffects.contentEditedNodeIds.push(
          ...result.contentEditedNodeIds,
        );
      }
      if (result.deferredFitFrameIds) {
        pendingEffects.deferredFitFrameIds.push(...result.deferredFitFrameIds);
      }
      if (result.affectedFrameIds) {
        for (const id of result.affectedFrameIds) {
          allAffectedFrameIds.add(id);
          // The count stepper / layout-mode switch wants its tracks
          // filled, not compacted away.
          if (cmd.type === 'SET_FRAME_LAYOUT') fillFrameIds.add(id);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Centralised frame auto-fit (single end-of-batch pass).
  //
  // Runs when either the user has auto-layout enabled OR the caller
  // explicitly opted in (e.g. agent batches must always refit frames
  // because the LLM cannot predict rendered dimensions accurately).
  //
  // Order: structured (`column` / `row`) frames first — they reposition
  // children into tracks and set their own content-driven size — then
  // the generic bounding-box `fitFrames` pass, which is a no-op for
  // frames the structured pass already handled (children are placed
  // exactly at `FRAME_PADDING` so the box matches) but still cascades
  // to ancestor frames so outer wrappers stay correctly sized.
  // ------------------------------------------------------------------
  if (
    anyApplied &&
    allAffectedFrameIds.size > 0 &&
    (state.autoLayoutEnabled || options.forceFitFrames)
  ) {
    const structured = applyStructuredFrameRelayout(
      currentNodes,
      allAffectedFrameIds,
      fillFrameIds,
    );
    currentNodes = fitFrames(
      structured.nodes as NestableNode[],
      allAffectedFrameIds,
    );
  }

  // ------------------------------------------------------------------
  // Derive batch-level metadata from COMMAND_META.
  // ------------------------------------------------------------------

  // Snapshot is needed if any command in the batch has snapshot:'yes'
  // and the execution doesn't declare caller-handled snapshots.
  const snapshotNeeded =
    anyApplied &&
    execution.commands.some((c) => COMMAND_META[c.type]?.snapshot === 'yes');

  // Edge reroute is needed if any *applied* command requires it.
  const requiresEdgeReroute = execution.commands.some(
    (c, i) =>
      commandResults[i]?.applied && COMMAND_META[c.type]?.requiresEdgeReroute,
  );

  return {
    writeResult: {
      nodes: currentNodes,
      edges: currentEdges,
      requiresEdgeReroute,
      snapshotNeeded,
    },
    commandResults,
    pendingEffects,
  };
}
