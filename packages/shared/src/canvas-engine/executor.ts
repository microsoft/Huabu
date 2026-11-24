// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Batch executor for canvas commands.
 *
 * Processes a list of edits against the current canvas state, returning the
 * new state and accumulated side-effect metadata. An edit is the commands of
 * one intent; {@link executeCanvasCommands} is the same run with one edit
 * per command.
 *
 * Responsibilities:
 * - Sequential execution: each edit sees the state the edits before it
 *   left, each command the state the commands before it left.
 * - **An edit is all-or-nothing.** When one of its commands does not take
 *   effect (any result that is not applied, other than `no-op`), the state
 *   returns to what it was when the edit began and everything the edit
 *   accumulated — pending effects, frames to fit, explicit frame sizes — is
 *   discarded. The end-of-batch passes below therefore run over the edits
 *   that took effect only. An edit made on top of an edit that did not take
 *   effect (`after`, `blocked`) does not run; other edits still apply.
 * - Collects affected parent frame IDs from each handler and performs a
 *   single deepest-first end-of-batch layout pass, fitting frames whose
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
import { settleTrackKeys } from './autoLayout/layoutOrder.js';
import { HANDLERS, COMMAND_META } from './commands/index.js';
import { isAllowedFor } from './commandScope.js';
import { settlePaintOrder } from './container/paintOrder.js';
import {
  fitFrameToChildren,
  normalizeTreeOrder,
  type NestableNode,
} from './frame/index.js';
import { getFrameSizing } from './frame/sizing.js';
import { hasValidPdfNoteOwnership, hidePdfNotes } from './pdfNotes.js';
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
  CanvasCommandFailureReason,
  CanvasCommandResult,
  CanvasEdit,
  CanvasEditResult,
  CanvasEditsExecution,
  CanvasExecution,
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
  /**
   * Host admission check, asked once per edit immediately before its first
   * command, with the edit's position and the state it would run against
   * (the evolving state, so it already reflects earlier edits).
   *
   * Returning a reason refuses the edit as a whole — every command of it is
   * recorded as not applied with that reason and no handler runs; the other
   * edits proceed as usual. Returning `undefined` admits it. Omitted, every
   * edit is admitted.
   */
  admitEdit?: (
    edit: CanvasEdit,
    index: number,
    state: Pick<CanvasReadState, 'nodes' | 'edges'>,
  ) => CanvasCommandFailureReason | undefined;
}

export interface ExecutorOutput {
  writeResult: CanvasWriteResult;
  /** One result per command, across all edits in order. */
  commandResults: CanvasCommandResult[];
  /** One result per edit. */
  editResults: CanvasEditResult[];
  /**
   * Pure side-effect manifest for host-specific drains. See
   * `applySharedPostEffects` (pure cleanups both hosts run) and
   * `runWebPostEffects` (web-only verbs).
   */
  pendingEffects: PendingEffects;
}

/**
 * Execute commands one by one, each on its own: a command that does not
 * take effect is skipped and the rest still apply. Exactly
 * {@link executeCanvasEdits} with one edit per command.
 */
export function executeCanvasCommands(
  execution: CanvasExecution,
  state: CanvasReadState,
  options: ExecutorOptions = {},
): ExecutorOutput {
  return executeCanvasEdits(
    {
      ...(execution.source ? { source: execution.source } : {}),
      edits: execution.commands.map((command) => ({ commands: [command] })),
    },
    state,
    options,
  );
}

/**
 * Execute a list of edits against the given state.
 *
 * Returns the new nodes/edges, execution metadata, and accumulated
 * side-effect requests. The caller (host layer) is responsible for:
 * 1. Committing the write result to its state store.
 * 2. Taking an undo snapshot if `writeResult.snapshotNeeded` is true.
 * 3. Running `applySharedPostEffects` for pure cleanups.
 * 4. Draining `pendingEffects` via the host-specific post-effect runner
 *    (`runWebPostEffects` on web; M2 will add a server counterpart).
 */
export function executeCanvasEdits(
  execution: CanvasEditsExecution,
  state: CanvasReadState,
  options: ExecutorOptions = {},
): ExecutorOutput {
  const source = execution.source ?? 'ui';

  // Mutable accumulators — built up as edits take effect.
  const commandResults: CanvasCommandResult[] = [];
  const editResults: CanvasEditResult[] = [];
  const pendingEffects: PendingEffects = {
    mutatedNodes: [],
    deletedNodeIds: [],
    contentEditedNodeIds: [],
    deferredFitFrameIds: [],
  };

  // Evolving state that each edit reads from / writes to.
  let currentNodes = state.nodes;
  let currentEdges = state.edges;

  // Aggregated parent frame IDs to refit at the end of the batch.
  const allAffectedFrameIds = new Set<string>();

  // Layout commands without explicit cells request filled tracks. Cell-aware
  // placement uses normal compaction, which retains Grid's interior gaps.
  const fillFrameIds = new Set<string>();
  const resizedFrameIds = new Set<string>();

  // Track whether any command was actually applied.
  let anyApplied = false;

  const refuseEdit = (
    edit: CanvasEdit,
    reason: CanvasCommandFailureReason,
  ): void => {
    const results = edit.commands.map((command) => ({
      command,
      applied: false,
      reason,
    }));
    commandResults.push(...results);
    editResults.push({ applied: false, reason, results });
  };

  for (const [editIndex, edit] of execution.edits.entries()) {
    // Made on top of an edit that did not take effect: not run.
    if (
      edit.blocked ||
      (edit.after ?? []).some(
        (earlier) =>
          earlier >= editIndex || editResults[earlier]?.applied !== true,
      )
    ) {
      refuseEdit(edit, 'stale-parent');
      continue;
    }
    const refused = options.admitEdit?.(edit, editIndex, {
      nodes: currentNodes,
      edges: currentEdges,
    });
    if (refused !== undefined) {
      refuseEdit(edit, refused);
      continue;
    }

    // Everything the edit does is staged here and joins the batch only when
    // the whole edit took effect. The engine advances state immutably, so
    // going back is keeping these two references.
    const startNodes = currentNodes;
    const startEdges = currentEdges;
    let editNodes = currentNodes;
    let editEdges = currentEdges;
    const results: CanvasCommandResult[] = [];
    const staged: PendingEffects = {
      mutatedNodes: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    };
    /** In command order: the fill request follows the last layout command. */
    const stagedFrames: Array<{ id: string; fill?: boolean }> = [];
    const stagedResized: string[] = [];
    let failedAt: number | undefined;

    for (const [commandIndex, cmd] of edit.commands.entries()) {
      const result = runCommand(cmd, {
        nodes: editNodes,
        edges: editEdges,
        canvasId: state.canvasId,
        source,
        batchPrestate: state.nodes,
      });
      results.push({
        command: cmd,
        applied: result.applied,
        ...(result.reason ? { reason: result.reason } : {}),
      });

      if (!result.applied) {
        if (result.reason === 'no-op') continue;
        failedAt = commandIndex;
        break;
      }

      if (cmd.type === 'SET_NODE_GEOMETRY') {
        const frameIds = new Set(
          result.nodes
            .filter((node) => node.type === 'frame')
            .map((node) => node.id),
        );
        for (const item of cmd.items) {
          if (item.size && frameIds.has(item.nodeId))
            stagedResized.push(item.nodeId);
        }
      }

      // Advance the evolving state so the next command of the edit sees
      // this command's changes. A track key the command left meaningless
      // goes first: the next command reads the children's order.
      editNodes = settleTrackKeys(
        result.nodes,
        editNodes,
        result.placedTrackKeyIds
          ? new Set(result.placedTrackKeyIds)
          : undefined,
      );
      editEdges = result.edges;

      if (result.mutatedNodes) staged.mutatedNodes.push(...result.mutatedNodes);
      if (result.deletedNodeIds)
        staged.deletedNodeIds.push(...result.deletedNodeIds);
      if (result.contentEditedNodeIds)
        staged.contentEditedNodeIds.push(...result.contentEditedNodeIds);
      if (result.deferredFitFrameIds)
        staged.deferredFitFrameIds.push(...result.deferredFitFrameIds);
      for (const id of result.affectedFrameIds ?? []) {
        // Explicit cells outrank count-stepper redistribution, including earlier commands.
        stagedFrames.push(
          cmd.type === 'SET_FRAME_LAYOUT'
            ? { id, fill: !cmd.cells?.length }
            : { id },
        );
      }
    }

    if (failedAt !== undefined) {
      // Nothing of the edit stays: the state is the one it started from and
      // what it staged is dropped. Its commands are reported as not applied
      // — the failing one with its reason, a no-op as a no-op.
      currentNodes = startNodes;
      currentEdges = startEdges;
      const failure = results[failedAt] as CanvasCommandResult;
      const reported = edit.commands.map((command, index) => {
        const ran = results[index];
        if (index === failedAt) return failure;
        if (ran && !ran.applied) return ran;
        return { command, applied: false };
      });
      commandResults.push(...reported);
      editResults.push({
        applied: false,
        ...(failure.reason ? { reason: failure.reason } : {}),
        failedAt,
        results: reported,
      });
      continue;
    }

    currentNodes = editNodes;
    currentEdges = editEdges;
    if (results.some((result) => result.applied)) anyApplied = true;
    pendingEffects.mutatedNodes.push(...staged.mutatedNodes);
    pendingEffects.deletedNodeIds.push(...staged.deletedNodeIds);
    pendingEffects.contentEditedNodeIds.push(...staged.contentEditedNodeIds);
    pendingEffects.deferredFitFrameIds.push(...staged.deferredFitFrameIds);
    for (const id of stagedResized) resizedFrameIds.add(id);
    for (const frame of stagedFrames) {
      allAffectedFrameIds.add(frame.id);
      if (frame.fill === true) fillFrameIds.add(frame.id);
      else if (frame.fill === false) fillFrameIds.delete(frame.id);
    }
    commandResults.push(...results);
    editResults.push({ applied: true, results });
  }

  // ------------------------------------------------------------------
  // Centralised frame auto-fit (single end-of-batch pass).
  //
  // Each affected Frame and ancestor is resolved once, deepest-first:
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
  //   2. `fitFrameToChildren` — generic bounding-box fit for free-mode
  //      ancestors. Gated by `getFrameSizing === 'hug'` (or
  //      `options.forceFitFrames` for agent batches). Structured
  //      frames short-circuit inside `fitFrameToChildren` anyway, so
  //      passing them through is defensive but harmless.
  //
  // Interleaving matters: a free child may change a structured parent's
  // footprint and vice versa. No ancestor may observe an unresolved child.
  //
  // Explicit Frame resize targets select the responsive tier. The resize
  // controller scales content after subtracting that tier's fixed whitespace;
  // ordinary content mutations resolve a stable Hug tier instead.
  // ------------------------------------------------------------------
  if (anyApplied && allAffectedFrameIds.size > 0) {
    // Structured relayout runs for every affected frame; the function
    // itself skips free-mode frames and per-frame branches on sizing
    // to decide whether to write the frame's own size.
    // Resolve the complete ancestor chain deepest-first, interleaving free
    // fitting and structured layout. Separate global passes leave structured
    // ancestors stale when an intervening free Frame changes its footprint.
    const byId = new Map(currentNodes.map((node) => [node.id, node]));
    const affected = new Set<string>();
    for (const seed of allAffectedFrameIds) {
      let id: string | undefined = seed;
      while (id && !affected.has(id)) {
        affected.add(id);
        id = byId.get(id)?.parentId;
      }
    }
    const depths = new Map<string, number>();
    const depth = (id: string): number => {
      const cached = depths.get(id);
      if (cached !== undefined) return cached;
      const seen = new Set<string>([id]);
      let parent = byId.get(id)?.parentId;
      let value = 0;
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        value++;
        parent = byId.get(parent)?.parentId;
      }
      depths.set(id, value);
      return value;
    };
    for (const id of [...affected].sort((a, b) => depth(b) - depth(a))) {
      currentNodes = applyStructuredFrameRelayout(
        currentNodes,
        [id],
        fillFrameIds,
        {
          edges: currentEdges,
          frozenGuttersByFrame: options.frozenStructuredGutters,
          resizedFrameIds,
        },
      ).nodes;
      // Explicit geometry is a boundary, not a seed that a descendant's
      // generic bounding-box fit may move. Manual ancestors stay pinned too.
      if (
        !resizedFrameIds.has(id) &&
        (options.forceFitFrames || getFrameSizing(byId.get(id)) === 'hug')
      ) {
        currentNodes = fitFrameToChildren(currentNodes as NestableNode[], id);
      }
    }
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
    // Paint order first: every node the batch created or moved to another
    // parent gets its own key for the place it stands in, and the array
    // follows the keys (see `container/paintOrder.ts`).
    currentNodes = hidePdfNotes(
      normalizeTreeOrder(
        settlePaintOrder(currentNodes as NestableNode[], state.nodes),
      ),
    );
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
    commandResults.some(
      (result) => COMMAND_META[result.command.type]?.snapshot === 'yes',
    );

  // Edge reroute is needed if any *applied* command requires it.
  const requiresEdgeReroute = commandResults.some(
    (result) =>
      result.applied && COMMAND_META[result.command.type]?.requiresEdgeReroute,
  );

  return {
    writeResult: {
      nodes: currentNodes,
      edges: currentEdges,
      requiresEdgeReroute,
      snapshotNeeded,
    },
    commandResults,
    editResults,
    pendingEffects,
  };
}

/**
 * Run one command against `context`: scope check, handler, and the PDF Note
 * ownership rule. Pure; the caller decides what to do with the result.
 */
function runCommand(
  cmd: CanvasCommand,
  context: {
    nodes: CanvasReadState['nodes'];
    edges: CanvasReadState['edges'];
    canvasId: string;
    source: NonNullable<CanvasEditsExecution['source']>;
    /** Nodes before the first edit, for the Note ownership comparison. */
    batchPrestate: CanvasReadState['nodes'];
  },
): ReturnType<CommandHandler<CanvasCommand>> {
  // What this source may issue at all; see `commandScope.ts`.
  if (!isAllowedFor(context.source, cmd)) {
    return {
      nodes: context.nodes,
      edges: context.edges,
      applied: false,
      reason: 'invalid-scope',
    };
  }

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
    nodes: context.nodes,
    edges: context.edges,
    canvasId: context.canvasId,
    source: context.source,
  });

  // Compare with the batch prestate so CREATE then link may initialize a new Note.
  if (
    result.applied &&
    ((cmd.type === 'CREATE_NODES' &&
      cmd.nodes.some((node) => 'noteNodeId' in (node.data ?? {}))) ||
      (cmd.type === 'MERGE_NODE_DATA' &&
        cmd.patches.some(
          ({ patch, unset }) =>
            'noteNodeId' in patch || unset?.includes('noteNodeId') === true,
        )) ||
      // An undo may bring a PDF back with its Note, or a Note back for
      // its PDF; it may not hand a PDF somebody else's Note.
      (cmd.type === 'RESTORE_NODES' &&
        (cmd.nodes ?? []).some((node) => 'noteNodeId' in (node.data ?? {})))) &&
    !hasValidPdfNoteOwnership(result.nodes, context.batchPrestate)
  ) {
    return {
      nodes: context.nodes,
      edges: context.edges,
      applied: false,
      reason: 'invalid-target',
    };
  }
  return result;
}
