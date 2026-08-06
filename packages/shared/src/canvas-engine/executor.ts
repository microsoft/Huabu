// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
 *   single end-of-batch `fitFrames` pass, filtered to frames whose
 *   `data.sizing` is `'hug'` (the default). Frames with `sizing:
 *   'manual'` are excluded so the user's pinned size sticks across
 *   child mutations. Handlers no longer fit frames themselves — they
 *   only declare which frames are affected.
 * - Uses COMMAND_META to determine snapshot policy and edge reroute needs.
 * - Collects pending effects from all commands.
 *
 * Most behaviour is source-agnostic. Handlers receive `execution.source`
 * for narrow source-specific semantics (for example, user-created nodes
 * becoming selected), and callers can force a refit pass over every affected
 * frame (even `sizing: 'manual'`) via `options.forceFitFrames`.
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
import {
  fitFrames,
  normalizeTreeOrder,
  type NestableNode,
} from './frame/index.js';
import { getFrameSizing } from './frame/sizing.js';
import { fitPortals } from './portal/index.js';
import {
  coerceProvenance,
  computeAiNoteProvenance,
} from './provenance/noteProvenance.js';

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
import type { StructuredGutterSizes } from './autoLayout/gridLayout.js';
import type { CommandHandler } from './commands/index.js';

export interface ExecutorOptions {
  /**
   * When true, the end-of-batch fit pass runs over *every* affected
   * parent frame, ignoring per-frame `sizing: 'manual'`. The web
   * caller sets this for agent-sourced batches because LLMs cannot
   * accurately predict rendered frame dimensions, so frames must
   * always be sized to fit their children unless the agent itself
   * explicitly set the frame's geometry in the same batch (the
   * `setNodeGeometry` handler protects those via `resizedFrameIds`).
   *
   * Default behaviour (false / omitted) honours each frame's
   * `sizing` policy.
   */
  forceFitFrames?: boolean;
  /** Per-frame gutter sizes frozen by a live resize gesture. */
  frozenStructuredGutters?: ReadonlyMap<string, StructuredGutterSizes>;
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
  const source = execution.source ?? 'ui';

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

  // Aggregated parent frame IDs to refit at the end of the batch.
  const allAffectedFrameIds = new Set<string>();
  const allAffectedPortalIds = new Set<string>();

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
      source,
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
      if (result.affectedPortalIds) {
        for (const id of result.affectedPortalIds) {
          allAffectedPortalIds.add(id);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Centralised frame auto-fit (single end-of-batch pass).
  //
  // Two sub-passes with different sizing gates:
  //
  //   1. `applyStructuredFrameRelayout` — runs for **all** affected
  //      structured (`column` / `row`) frames regardless of sizing.
  //      Internally:
  //        - `hug`    → re-pack children **and** write the solver's
  //                     content-driven frame size into style+measured.
  //        - `manual` → re-pack children only; the user-pinned frame
  //                     size is preserved (children may overflow the
  //                     main axis when the pin is smaller than the
  //                     packed content — start-aligned, allowed to
  //                     spill). Free-mode frames are no-ops here
  //                     (filtered by `readFrameGridConfig`).
  //
  //   2. `fitFrames` — generic bounding-box pass for free-mode
  //      ancestors. Gated by `getFrameSizing === 'hug'` (or
  //      `options.forceFitFrames` for agent batches). Structured
  //      frames short-circuit inside `fitFrameToChildren` anyway, so
  //      passing them through is defensive but harmless.
  //
  // Order matters: structured solver may resize a hug frame, which
  // then needs to be reflected in the bounding-box pass for any
  // ancestor wrappers.
  //
  // Per-axis padding makes the structured solver self-consistent
  // under per-axis resize: scaling all child widths by `sx` makes
  // `padX` + `interGapX` scale by `sx` too, so the resulting frame
  // width = `oldWidth × sx` exactly — `flushScale` therefore passes
  // the raw (sx, sy) from the resize gesture through without
  // collapsing to a uniform scalar.
  // ------------------------------------------------------------------
  if (anyApplied && allAffectedFrameIds.size > 0) {
    // fitFrames gate: hug-only (or all, when forced).
    const fitTargets = options.forceFitFrames
      ? allAffectedFrameIds
      : new Set<string>();
    if (!options.forceFitFrames) {
      const nodeById = new Map(currentNodes.map((n) => [n.id, n]));
      for (const id of allAffectedFrameIds) {
        if (getFrameSizing(nodeById.get(id)) === 'hug') {
          fitTargets.add(id);
        }
      }
    }
    // Structured relayout runs for every affected frame; the function
    // itself skips free-mode frames and per-frame branches on sizing
    // to decide whether to write the frame's own size.
    const structured = applyStructuredFrameRelayout(
      currentNodes,
      allAffectedFrameIds,
      fillFrameIds,
      {
        edges: currentEdges,
        frozenGuttersByFrame: options.frozenStructuredGutters,
      },
    );
    currentNodes = structured.nodes;
    if (fitTargets.size > 0) {
      currentNodes = fitFrames(currentNodes as NestableNode[], fitTargets);
    }
  }

  if (anyApplied && allAffectedPortalIds.size > 0) {
    currentNodes = fitPortals(
      currentNodes as NestableNode[],
      allAffectedPortalIds,
    );
  }

  // ------------------------------------------------------------------
  // Authoritative tree-order invariant (single end-of-batch pass).
  //
  // Parents must precede their children in the array and frame children
  // must carry the frame zIndex; otherwise React Flow throws "Parent node
  // not found" on the client. This is the single funnel every command
  // batch passes through, so normalizing HERE lets individual commands stop
  // maintaining the invariant themselves. `normalizeTreeOrder` is idempotent
  // and returns the same array reference when order/zIndex already hold, so
  // the common (already-ordered) batch pays only an O(n) fast-path check
  // (no sort, no remap, no allocation).
  // ------------------------------------------------------------------
  if (anyApplied) {
    currentNodes = normalizeTreeOrder(currentNodes as NestableNode[]);
  }

  // ------------------------------------------------------------------
  // Note block provenance (agent batches only).
  //
  // `MERGE_NODE_DATA` reports which notes had their `content` rewritten
  // (`contentEditedNodeIds`). For AI-authored batches we compute
  // block-level provenance HERE — at the authoritative mutation point —
  // by diffing each note's pre-edit content against its new content.
  // The result is written onto `data.provenance` so it rides the node's
  // REPLACE_NODE delta into the broadcast; every client then renders
  // identical attribution without re-deriving anything in the editor
  // (and unexpanded notes get provenance too, since it no longer
  // depends on a live Milkdown instance).
  //
  // User-sourced batches are skipped: the editor shifts provenance
  // locally against the live doc on each keystroke.
  // ------------------------------------------------------------------
  if (
    anyApplied &&
    source === 'agent' &&
    pendingEffects.contentEditedNodeIds.length > 0
  ) {
    const prevById = new Map(state.nodes.map((n) => [n.id, n]));
    const editedIds = new Set(pendingEffects.contentEditedNodeIds);
    const provByNodeId = new Map<string, ReturnType<typeof coerceProvenance>>();
    currentNodes = currentNodes.map((node) => {
      if (node.type !== 'note' || !editedIds.has(node.id)) return node;
      const data = (node.data ?? {}) as Record<string, unknown>;
      const newContent = typeof data.content === 'string' ? data.content : '';
      const prevData = (prevById.get(node.id)?.data ?? {}) as Record<
        string,
        unknown
      >;
      const oldContent =
        typeof prevData.content === 'string' ? prevData.content : '';
      const provenance = computeAiNoteProvenance(
        coerceProvenance(prevData.provenance),
        oldContent,
        newContent,
      );
      provByNodeId.set(node.id, provenance);
      return { ...node, data: { ...data, provenance } };
    });

    // Reflect the computed provenance onto the mutated-node manifest so
    // the server's sidecar write (`buildNodeContent`) persists it — the
    // manifest, not `currentNodes`, is what the host writes to disk.
    if (provByNodeId.size > 0) {
      pendingEffects.mutatedNodes = pendingEffects.mutatedNodes.map((n) => {
        const provenance = provByNodeId.get(n.id);
        if (!provenance) return n;
        return {
          ...n,
          data: { ...(n.data ?? {}), provenance },
        };
      });
    }
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
