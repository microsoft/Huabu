// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  autoFrameNodeByOverlap,
  autoUnframeNodeByNonOverlap,
  FRAME_POINTER_CAPTURE_MARGIN,
  moveNodeIntoFrame,
  moveNodeOutOfFrame,
  pickColumnDropTarget,
  pickRowDropTarget,
  planStructuredDrop,
  readFrameGridConfig,
  readFrameGridRow,
  readFrameTrack,
  resolveFrameTrackCount,
  projectAffectedFrameGeometry,
  wouldStickToStructuredFrame,
  type FrameAxis,
  type FrameGridAxis,
  type NestableNode,
  type StructuredDropTarget,
} from '@huabu/shared/canvas-engine';

import { extractNodeRef, canvasSizeFromStyle } from '../utils';
import { buildStructuredFrameRelayoutCommands } from '../utils/frameLayout';

import type {
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';
import type { FrameCellPatch } from '../utils/frameLayout';
import type {
  CanvasCommand,
  CanvasNodeGeometryUpdate,
  CanvasNodeId,
  RecentAction,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

export default function resolveNodeDragStop(
  intent: Extract<CanvasUiIntent, { type: 'NODE_DRAG_STOP' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const commands: CanvasCommand[] = [];
  const { nodes } = ui;

  // Capture parentId before auto-frame mutation.
  const preParentIds = new Map(nodes.map((n) => [n.id, n.parentId]));

  // Apply auto-frame / auto-unframe for every dragged node.
  let result = nodes as NestableNode[];
  for (const id of intent.draggedNodeIds) {
    // Space-held drag opts out of auto-reparenting (entering /
    // leaving frames). Skip the per-node frame-detection logic so
    // this node keeps its current parent regardless of release
    // position. The downstream frame-fit, geometry-diff, and
    // structured-slot reorder logic still runs so the new position
    // commits and the parent frame refits / re-flows around it.
    if (intent.bypassReparent) continue;

    // ── Cached-decision fast path ───────────────────────────────────
    // When the live preview tick recorded a decision for this node,
    // honour it verbatim — the user's last rendered frame is the
    // source of truth (WYSIWYG). Skipping the fresh predicate calls
    // here eliminates the preview/resolver drift caused by smart-snap
    // rewriting positions and the mouseup pointer being a different
    // DOM event from the last `mousemove`.
    //
    // The cache stores only the boolean / target-id decisions, not
    // pre-computed mutated trees, so the resolver still owns position
    // preservation (delegated to `moveNodeIntoFrame` /
    // `moveNodeOutOfFrame`, which keep the absolute placement
    // identical across the parent swap).
    const cached = intent.cachedDecisions?.get(id);
    if (cached) {
      const post = result.find((n) => n.id === id);
      const currentParent = post?.parentId ?? null;

      // Cache says "leave the current frame" and we still have one to
      // leave: detach. When `currentParent` is already null, the
      // cache must have been computed against a stale tree (or the
      // node was already detached by a previous iteration) — either
      // way there is nothing to unframe.
      if (cached.unframe && currentParent) {
        result = moveNodeOutOfFrame(result, id);
      }
      // Cache says "enter this frame" and we are not already there:
      // attach. Re-reading `result.find` after the potential unframe
      // above so the parent check sees the freshly-detached node.
      // `moveNodeIntoFrame` is a no-op when the node is already
      // parented to the target, so the duplicate check is purely
      // defensive against future API drift.
      if (cached.enterFrameId) {
        const refreshed = result.find((n) => n.id === id);
        if (refreshed?.parentId !== cached.enterFrameId) {
          result = moveNodeIntoFrame(result, id, cached.enterFrameId);
        }
      }
      continue;
    }

    // ── Fresh-recomputation fallback ────────────────────────────────
    // No cached decision means the live preview tick never ran for
    // this drag (instant click-release or the preview short-circuited
    // before reaching this node). Fall back to the original halo /
    // overlap logic — there is no "previous preview" contract to
    // honour.
    //
    // Keep a node inside its structured (column / row) frame whenever the
    // release pointer is within the frame's *capture zone* — the frame
    // rect expanded by the dragged node's size. Appending / prepending a
    // track requires hovering the outer padding (and usually dragging the
    // node's body slightly past the edge, giving zero body-overlap), so a
    // strict in-frame test would unframe the node and drop it outside,
    // contradicting the live "insert column / row" preview. The node-size
    // margin makes the edge bands reachable while a clearly-away drag
    // (beyond one node-size) still unframes.
    const dragSize = nodeRectSize(nodes, id);
    const stickToStructured = wouldStickToStructuredFrame(
      nodes as NestableNode[],
      id,
      intent.pointerFlowPosition,
    );
    if (!stickToStructured) {
      // Free-mode frames use a pointer-capture halo so a child node
      // stays parented while the user repositions it inside the frame —
      // even when the node's body grazes or briefly extends past the
      // frame edge. The structured-frame branch above handles its own
      // (much larger) capture zone, so this only applies to free
      // frames. The pre-existing `margin: 10` body-gap rule remains as
      // the fallback when the pointer leaves the halo.
      //
      // Halo scales with the dragged node's size (0.3× per axis,
      // floored at `FRAME_POINTER_CAPTURE_MARGIN`) so that big nodes —
      // whose body easily reaches well past a small frame's edge during
      // ordinary repositioning — still feel sticky. Tiny nodes keep the
      // fixed 24 px floor so the halo is always at least visible to the
      // eye.
      result = autoUnframeNodeByNonOverlap(result, id, {
        epsilon: 0,
        margin: 10,
        pointer: intent.pointerFlowPosition,
        pointerCaptureMargin: {
          x: Math.max(FRAME_POINTER_CAPTURE_MARGIN, dragSize.width * 0.3),
          y: Math.max(FRAME_POINTER_CAPTURE_MARGIN, dragSize.height * 0.3),
        },
      });
    }
    // Cursor-based entry: a candidate frame qualifies when the pointer
    // is inside its rect AND there is any positive body overlap, in
    // addition to the original 50% area-ratio threshold. Lets users
    // drop a node by hovering near the frame edge or drop a node larger
    // than the frame without having to centre it.
    result = autoFrameNodeByOverlap(result, id, {
      threshold: 0.5,
      pointer: intent.pointerFlowPosition,
      allowNestedFrameEntry: intent.allowNestedFrameEntry,
    });
  }

  // Collect parent changes first. Geometry is diffed only after affected Hug
  // Frames have fitted, so the batch includes the fitted Frame and child
  // coordinates rather than the intermediate reparent geometry.
  const geometryUpdates: CanvasNodeGeometryUpdate[] = [];
  const parentChanges = new Map<string, string | null>();

  for (const id of intent.draggedNodeIds) {
    const node = result.find((n) => n.id === id);
    if (!node) continue;

    const prevParentId = preParentIds.get(id);
    const nextParentId = node.parentId ?? null;

    if (prevParentId !== nextParentId) {
      parentChanges.set(id, nextParentId);
    }
  }

  // Fit affected frames — per-frame sizing gate: only `hug` parents
  // chase their children's new positions; `manual` parents keep their
  // pinned size. The engine's end-of-batch pass applies the same
  // filter; we pre-fit here only so the geometry-update diff below
  // sees the new frame positions / sizes.
  const affectedFrameIds = new Set<string>();
  for (const id of intent.draggedNodeIds) {
    const prevParentId = preParentIds.get(id);
    const node = result.find((n) => n.id === id);
    if (prevParentId) affectedFrameIds.add(prevParentId);
    if (node?.parentId) affectedFrameIds.add(node.parentId);
  }
  const projection = projectAffectedFrameGeometry(
    result,
    affectedFrameIds,
    ui.edges,
  );
  result = projection.nodes;
  for (const frameId of projection.affectedFrameIds) {
    affectedFrameIds.add(frameId);
  }

  for (const node of result) {
    const original = nodes.find((candidate) => candidate.id === node.id);
    if (!original) continue;
    const positionChanged =
      original.position.x !== node.position.x ||
      original.position.y !== node.position.y;
    const size = canvasSizeFromStyle(node.style);
    const originalSize = canvasSizeFromStyle(original.style);
    const sizeChanged =
      size?.width !== originalSize?.width ||
      size?.height !== originalSize?.height;
    if (!positionChanged && !sizeChanged) continue;
    geometryUpdates.push({
      nodeId: node.id as CanvasNodeId,
      ...(positionChanged ? { position: node.position } : {}),
      ...(sizeChanged && size ? { size } : {}),
    });
  }

  const dropPlans = collectGridDropPlans(
    intent.draggedNodeIds,
    result,
    ui.nodes,
    ui.edges,
    intent.pointerFlowPosition,
  );
  const dropOutcome = buildGridDropCommands(dropPlans, ui.nodes);

  if (parentChanges.size === 0) {
    if (affectedFrameIds.size > 0) {
      if (geometryUpdates.length > 0) {
        commands.push({ type: 'SET_NODE_GEOMETRY', items: geometryUpdates });
      }
    }
    commands.push(...dropOutcome.commands);
    commands.push(
      ...buildStructuredFrameRelayoutCommands(affectedFrameIds, result, {
        cellPatches: dropOutcome.cellPatches,
        frameDataPatches: dropOutcome.frameDataPatches,
      }),
    );
    const movedNodes = intent.draggedNodeIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is Node => !!n);
    return {
      commands,
      trace:
        movedNodes.length > 0
          ? [{ action: 'nodes_moved', nodes: movedNodes.map(extractNodeRef) }]
          : [],
    };
  }

  // Emit parent changes as SET_NODE_PARENT commands.
  const byParent = new Map<string | null, string[]>();
  for (const [nodeId, parentId] of parentChanges) {
    const key = parentId ?? '';
    const bucket = byParent.get(key);
    if (bucket) {
      bucket.push(nodeId);
    } else {
      byParent.set(key, [nodeId]);
    }
  }
  for (const [parentKey, nodeIds] of byParent) {
    commands.push({
      type: 'SET_NODE_PARENT',
      nodeIds: nodeIds as CanvasNodeId[],
      parentId: (parentKey || null) as CanvasNodeId | null,
    });
  }

  if (geometryUpdates.length > 0) {
    commands.push({ type: 'SET_NODE_GEOMETRY', items: geometryUpdates });
  }

  commands.push(...dropOutcome.commands);
  commands.push(
    ...buildStructuredFrameRelayoutCommands(affectedFrameIds, result, {
      cellPatches: dropOutcome.cellPatches,
      frameDataPatches: dropOutcome.frameDataPatches,
    }),
  );

  // Build trace: framed/unframed + moved.
  const trace: RecentAction[] = [];
  for (const [nodeId, newParentId] of parentChanges) {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    if (newParentId) {
      const frame = nodes.find((n) => n.id === newParentId);
      if (frame) {
        trace.push({
          action: 'node_framed',
          node: extractNodeRef(node),
          frame: extractNodeRef(frame),
        });
      }
    } else {
      const prevParentId = preParentIds.get(nodeId);
      const frame = prevParentId
        ? nodes.find((n) => n.id === prevParentId)
        : undefined;
      if (frame) {
        trace.push({
          action: 'node_unframed',
          node: extractNodeRef(node),
          frame: extractNodeRef(frame),
        });
      }
    }
  }
  const movedNodes = intent.draggedNodeIds
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is Node => !!n);
  if (movedNodes.length > 0) {
    trace.push({
      action: 'nodes_moved',
      nodes: movedNodes.map(extractNodeRef),
    });
  }

  return { commands, trace };
}

// ── Local helpers ──────────────────────────────────────────────────────

/**
 * Per-dragged-node picker output. Captures the target frame plus the
 * raw picker decision (existing slot vs. insert-new-track). The
 * `kind === 'insert-new'` form may be demoted to `'into-existing'`
 * later when the gesture context disallows growing the grid
 * (multi-drag, frame already at max count, …).
 */
interface GridDropPlan {
  nodeId: CanvasNodeId;
  frameId: string;
  axis: FrameGridAxis;
  count: number; // pre-drop count
  target: StructuredDropTarget;
  rowTarget?: StructuredDropTarget;
}

/**
 * Outcome of converting a batch of per-node `GridDropPlan` entries
 * into concrete canvas commands. The frame-layout patches double as
 * `pending` input for {@link buildStructuredFrameRelayoutCommands} so
 * the layout pass sees the post-batch `gridCount`.
 */
interface GridDropCommands {
  commands: CanvasCommand[];
  cellPatches: Array<{ nodeId: CanvasNodeId; patch: FrameCellPatch }>;
  frameDataPatches: Array<{ nodeId: string; patch: Record<string, unknown> }>;
}

/**
 * For each dragged node that lands inside a structured frame, ask the
 * grid picker what should happen:
 *
 *  - Column masonry → the column under the cursor (mouse X).
 *  - Row masonry    → the row under the cursor (mouse Y).
 *  - Grid → column under the cursor plus the persistent row under the
 *    cursor. Column uses `frameSlot`; row uses `frameRow`.
 *
 * Either kind of target may be returned **on either axis**: drop into an
 * existing track, or insert a brand-new one at the cursor's gap (used to
 * grow the grid by drag-and-drop, along X and — for `grid` — along Y).
 *
 * Falls back to the child's own top-left when the cursor isn't
 * available (programmatic emits, touch). All dragged nodes in a
 * multi-select share the same cursor point — matches ReactFlow's
 * single-cursor model.
 */
function collectGridDropPlans(
  draggedIds: string[],
  postDragNodes: NestableNode[],
  preDragNodes: Node[],
  edges: UiResolverState['edges'],
  pointerFlowPosition?: { x: number; y: number },
): GridDropPlan[] {
  const plans: GridDropPlan[] = [];
  for (const id of draggedIds) {
    const post = postDragNodes.find((n) => n.id === id);
    if (!post?.parentId) continue;
    const frame = preDragNodes.find((n) => n.id === post.parentId);
    if (!frame) continue;
    const cfg = readFrameGridConfig(frame);
    if (!cfg) continue;
    const count = resolveFrameTrackCount(preDragNodes, frame.id);

    // Convert cursor → frame-local space; fall back to child top-left.
    const framePoint = pointerFlowPosition
      ? {
          x: pointerFlowPosition.x - absoluteX(preDragNodes, frame.id),
          y: pointerFlowPosition.y - absoluteY(preDragNodes, frame.id),
        }
      : { x: post.position.x, y: post.position.y };

    const target =
      cfg.axis === 'row'
        ? pickRowDropTarget(preDragNodes, frame.id, framePoint.y, edges)
        : pickColumnDropTarget(preDragNodes, frame.id, framePoint.x, edges);

    plans.push({
      nodeId: id as CanvasNodeId,
      frameId: frame.id,
      axis: cfg.axis,
      count,
      target,
      ...(cfg.axis === 'grid'
        ? {
            rowTarget: pickRowDropTarget(
              preDragNodes,
              frame.id,
              framePoint.y,
              edges,
            ),
          }
        : {}),
    });
  }
  return plans;
}

/**
 * Translate a batch of per-node `GridDropPlan` entries into canvas
 * commands. Grouped by target frame, the per-frame flow is:
 *
 *  1. Build the post-drop slot assignment for every child of the frame:
 *     - `insert-new` (single dragged node, grid not at max) opens a
 *       brand-new track at the cursor's gap and shifts existing tracks
 *       at/after it up by one;
 *     - otherwise each dragged node moves into an existing track (a
 *       demoted insert-new clamps into range).
 *     `grid` additionally resolves a row target the same way, except
 *     that opening a row yields to opening a column in the same
 *     gesture — the new column is empty, so nothing needs pushing down.
 *  2. **Compact** the occupied tracks to a contiguous `0..K-1` range
 *     whenever a move empties a previously-occupied track (or the grid
 *     just grew). This makes `gridCount` equal the number of occupied
 *     columns / rows: dragging the **sole** occupant out of a column
 *     deletes that column instead of leaving a phantom empty track that
 *     the solver's no-empty-track rebalance would immediately refill.
 *     A plain move that doesn't empty its source track keeps the
 *     current count and only re-slots the dragged node(s).
 *
 * `cellPatches` / `frameDataPatches` mirror the emitted commands so the
 * caller can feed them into {@link buildStructuredFrameRelayoutCommands}
 * as `pending` input.
 */
function buildGridDropCommands(
  plans: GridDropPlan[],
  preDragNodes: Node[],
): GridDropCommands {
  if (plans.length === 0) {
    return {
      commands: [],
      cellPatches: [],
      frameDataPatches: [],
    };
  }

  const out: GridDropCommands = {
    commands: [],
    cellPatches: [],
    frameDataPatches: [],
  };

  // Group plans by target frame.
  const byFrame = new Map<string, GridDropPlan[]>();
  for (const plan of plans) {
    const bucket = byFrame.get(plan.frameId);
    if (bucket) bucket.push(plan);
    else byFrame.set(plan.frameId, [plan]);
  }

  for (const [frameId, framePlans] of byFrame) {
    const { axis, count } = framePlans[0];
    // The count axis is the one the mode is named after; `grid` counts
    // columns and addresses rows separately.
    const trackAxis: FrameAxis = axis === 'row' ? 'row' : 'column';
    const trackField = axis === 'row' ? 'frameRow' : 'frameColumn';

    // What the drop means is decided by the shared planner — the same
    // call the live preview makes, against the same pre-drag geometry,
    // so the commit cannot land somewhere the preview did not show.
    const plan = planStructuredDrop(
      preDragNodes as NestableNode[],
      frameId,
      axis,
      count,
      framePlans.map((framePlan) => ({
        nodeId: framePlan.nodeId as string,
        target: framePlan.target,
        rowTarget: framePlan.rowTarget,
      })),
    );

    // Stored cells, to emit patches only where something moved.
    const origSlot = new Map<string, number>();
    const origRow = new Map<string, number>();
    for (const node of preDragNodes) {
      if (node.parentId !== frameId) continue;
      origSlot.set(
        node.id,
        clampSlot(readFrameTrack(node, trackAxis) ?? 0, count),
      );
      if (axis === 'grid') {
        origRow.set(node.id, Math.max(0, readFrameGridRow(node) ?? 0));
      }
    }

    // A track count change re-interprets every cell in the frame, so the
    // drop states all of them on the layout command itself. `cells`
    // outranks that command's own "explicit count ⇒ re-flow in reading
    // order" fallback, which exists for a caller that names a count
    // WITHOUT knowing where anything should go (the frame toolbar). The
    // drop does know, and letting the fallback run against the cells it
    // did not restate left the ones it happened to agree with re-dealt —
    // two children in the same cell, and a commit the preview never
    // showed.
    const cells: Array<{
      nodeId: CanvasNodeId;
      column?: number;
      row?: number;
    }> = [];
    const mergePatches: Array<{
      nodeId: CanvasNodeId;
      patch: Record<string, unknown>;
    }> = [];
    for (const [id, slot] of plan.tracks) {
      const row = plan.rows.get(id);
      cells.push({
        nodeId: id as CanvasNodeId,
        ...(axis === 'row' ? { row: slot } : { column: slot }),
        ...(axis === 'grid' && typeof row === 'number' ? { row } : {}),
      });
      const slotChanged = origSlot.get(id) !== slot;
      const rowChanged = typeof row === 'number' && origRow.get(id) !== row;
      if (!slotChanged && !rowChanged) continue;
      const patch: FrameCellPatch = {
        ...(slotChanged ? { [trackField]: slot } : {}),
        ...(rowChanged ? { frameRow: row } : {}),
      };
      mergePatches.push({ nodeId: id as CanvasNodeId, patch });
      out.cellPatches.push({ nodeId: id as CanvasNodeId, patch });
    }

    if (plan.count !== count) {
      out.commands.push({
        type: 'SET_FRAME_LAYOUT',
        frameId: frameId as CanvasNodeId,
        mode: axis,
        gridCount: plan.count,
        cells,
      });
      out.frameDataPatches.push({
        nodeId: frameId,
        patch: { layoutMode: axis, gridCount: plan.count },
      });
    } else if (mergePatches.length > 0) {
      // The cells are unambiguous without the count change, so only the
      // children that actually moved are written.
      out.commands.push({ type: 'MERGE_NODE_DATA', patches: mergePatches });
    }
  }

  return out;
}

/** Clamp a raw slot index into the `[0, count - 1]` track range. */
function clampSlot(value: number, count: number): number {
  if (value < 0) return 0;
  const max = Math.max(0, count - 1);
  return value > max ? max : value;
}

function absoluteX(nodes: Node[], nodeId: string): number {
  let sum = 0;
  let cursor: string | undefined = nodeId;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const node = nodes.find((n) => n.id === cursor);
    if (!node) break;
    sum += node.position.x;
    cursor = node.parentId;
  }
  return sum;
}

function absoluteY(nodes: Node[], nodeId: string): number {
  let sum = 0;
  let cursor: string | undefined = nodeId;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const node = nodes.find((n) => n.id === cursor);
    if (!node) break;
    sum += node.position.y;
    cursor = node.parentId;
  }
  return sum;
}

/** Width / height of a node from its measured size, then style, else 0. */
function nodeRectSize(
  nodes: Node[],
  nodeId: string,
): { width: number; height: number } {
  const node = nodes.find((n) => n.id === nodeId);
  const width =
    (node?.measured as { width?: number } | undefined)?.width ??
    (node?.style as { width?: number } | undefined)?.width ??
    0;
  const height =
    (node?.measured as { height?: number } | undefined)?.height ??
    (node?.style as { height?: number } | undefined)?.height ??
    0;
  return { width, height };
}
