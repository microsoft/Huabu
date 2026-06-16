import {
  FRAME_GRID_MAX_COUNT,
  FRAME_GRID_MIN_COUNT,
  type FrameLayoutMode,
} from '@sediment/shared';
import {
  autoFrameNodeByOverlap,
  autoUnframeNodeByNonOverlap,
  fitFrames,
  pickColumnDropTarget,
  pickRowDropTarget,
  readFrameGridConfig,
  type NestableNode,
  type StructuredDropTarget,
} from '@sediment/shared/canvas-engine';

import { extractNodeRef, canvasSizeFromStyle } from '../utils';
import { buildStructuredFrameRelayoutCommands } from '../utils/frameLayout';

import type {
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';
import type {
  CanvasCommand,
  CanvasNodeId,
  RecentAction,
} from '@sediment/shared';
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
    // Keep a node inside its structured (column / row) frame whenever the
    // release pointer is within the frame's *capture zone* — the frame
    // rect expanded by the dragged node's size. Appending / prepending a
    // track requires hovering the outer padding (and usually dragging the
    // node's body slightly past the edge, giving zero body-overlap), so a
    // strict in-frame test would unframe the node and drop it outside,
    // contradicting the live "insert column / row" preview. The node-size
    // margin makes the edge bands reachable while a clearly-away drag
    // (beyond one node-size) still unframes.
    const preParent = preParentIds.get(id);
    const dragSize = nodeRectSize(nodes, id);
    const stickToStructured =
      !!preParent &&
      !!intent.pointerFlowPosition &&
      pointerInsideStructuredFrame(
        nodes,
        preParent,
        intent.pointerFlowPosition,
        dragSize.width,
        dragSize.height,
      );
    if (!stickToStructured) {
      result = autoUnframeNodeByNonOverlap(result, id, {
        epsilon: 0,
        margin: 10,
      });
    }
    result = autoFrameNodeByOverlap(result, id, { threshold: 0.5 });
  }

  // Collect geometry updates and parent changes.
  const geometryUpdates: Array<{
    nodeId: CanvasNodeId;
    position: { x: number; y: number };
  }> = [];
  const parentChanges = new Map<string, string | null>();

  for (const id of intent.draggedNodeIds) {
    const node = result.find((n) => n.id === id);
    if (!node) continue;

    const prevParentId = preParentIds.get(id);
    const nextParentId = node.parentId ?? null;

    if (prevParentId !== nextParentId) {
      parentChanges.set(id, nextParentId);
      geometryUpdates.push({
        nodeId: id as CanvasNodeId,
        position: node.position,
      });
    }
  }

  // Fit affected frames.
  const affectedFrameIds = new Set<string>();
  for (const id of intent.draggedNodeIds) {
    const prevParentId = preParentIds.get(id);
    const node = result.find((n) => n.id === id);
    if (prevParentId) affectedFrameIds.add(prevParentId);
    if (node?.parentId) affectedFrameIds.add(node.parentId);
  }
  if (ui.autoLayoutEnabled && affectedFrameIds.size > 0) {
    result = fitFrames(result, affectedFrameIds);
  }

  const dropPlans = collectGridDropPlans(
    intent.draggedNodeIds,
    result,
    ui.nodes,
    intent.pointerFlowPosition,
  );
  const dropOutcome = buildGridDropCommands(dropPlans, ui.nodes);

  if (parentChanges.size === 0) {
    if (affectedFrameIds.size > 0) {
      for (const n of result) {
        const original = nodes.find((o) => o.id === n.id);
        if (
          original &&
          (original.position !== n.position || original.style !== n.style)
        ) {
          const size = canvasSizeFromStyle(n.style);
          geometryUpdates.push({
            nodeId: n.id as CanvasNodeId,
            position: n.position,
            ...(size && { size }),
          } as never);
        }
      }
      if (geometryUpdates.length > 0) {
        commands.push({ type: 'SET_NODE_GEOMETRY', items: geometryUpdates });
      }
    }
    commands.push(...dropOutcome.commands);
    commands.push(
      ...buildStructuredFrameRelayoutCommands(affectedFrameIds, result, {
        slotPatches: dropOutcome.slotPatches,
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
      slotPatches: dropOutcome.slotPatches,
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
  axis: 'column' | 'row';
  count: number; // pre-drop count
  target: StructuredDropTarget;
}

/**
 * Outcome of converting a batch of per-node `GridDropPlan` entries
 * into concrete canvas commands. The frame-layout patches double as
 * `pending` input for {@link buildStructuredFrameRelayoutCommands} so
 * the layout pass sees the post-batch `gridCount`.
 */
interface GridDropCommands {
  commands: CanvasCommand[];
  slotPatches: Array<{ nodeId: CanvasNodeId; slot: number }>;
  frameDataPatches: Array<{ nodeId: string; patch: Record<string, unknown> }>;
}

/**
 * For each dragged node that lands inside a structured frame, ask the
 * grid picker what should happen:
 *
 *  - Column masonry → the column under the cursor (mouse X).
 *  - Row masonry    → the row under the cursor (mouse Y).
 *
 * Either kind of target may be returned: drop into an existing track,
 * or insert a brand-new track at the cursor's gap position (used to
 * grow the grid by drag-and-drop).
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

    // Convert cursor → frame-local space; fall back to child top-left.
    const framePoint = pointerFlowPosition
      ? {
          x: pointerFlowPosition.x - absoluteX(preDragNodes, frame.id),
          y: pointerFlowPosition.y - absoluteY(preDragNodes, frame.id),
        }
      : { x: post.position.x, y: post.position.y };

    const target =
      cfg.axis === 'column'
        ? pickColumnDropTarget(preDragNodes, frame.id, framePoint, cfg.count)
        : pickRowDropTarget(preDragNodes, frame.id, framePoint, cfg.count);

    plans.push({
      nodeId: id as CanvasNodeId,
      frameId: frame.id,
      axis: cfg.axis,
      count: cfg.count,
      target,
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
 *  2. **Compact** the occupied tracks to a contiguous `0..K-1` range
 *     whenever a move empties a previously-occupied track (or the grid
 *     just grew). This makes `gridCount` equal the number of occupied
 *     columns / rows: dragging the **sole** occupant out of a column
 *     deletes that column instead of leaving a phantom empty track that
 *     the solver's no-empty-track rebalance would immediately refill.
 *     A plain move that doesn't empty its source track keeps the
 *     current count and only re-slots the dragged node(s).
 *
 * `slotPatches` / `frameDataPatches` mirror the emitted commands so the
 * caller can feed them into {@link buildStructuredFrameRelayoutCommands}
 * as `pending` input.
 */
function buildGridDropCommands(
  plans: GridDropPlan[],
  preDragNodes: Node[],
): GridDropCommands {
  if (plans.length === 0) {
    return { commands: [], slotPatches: [], frameDataPatches: [] };
  }

  const out: GridDropCommands = {
    commands: [],
    slotPatches: [],
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

    // Stored slot for every existing child of this frame (clamped).
    const origSlot = new Map<string, number>();
    const childIds: string[] = [];
    for (const node of preDragNodes) {
      if (node.parentId !== frameId) continue;
      const raw = (node.data as { frameSlot?: number } | undefined)?.frameSlot;
      const s =
        typeof raw === 'number' && Number.isFinite(raw)
          ? clampSlot(Math.round(raw), count)
          : 0;
      origSlot.set(node.id, s);
      childIds.push(node.id);
    }

    // Working assignment = stored slots; dragged nodes overwritten below.
    const slotOf = new Map<string, number>(origSlot);
    // Include any dragged node that just entered this frame from outside.
    for (const plan of framePlans) {
      if (!slotOf.has(plan.nodeId)) childIds.push(plan.nodeId);
    }

    const insertPlan =
      framePlans.length === 1 &&
      framePlans[0].target.kind === 'insert-new' &&
      count < FRAME_GRID_MAX_COUNT
        ? framePlans[0]
        : null;

    if (insertPlan && insertPlan.target.kind === 'insert-new') {
      // Open a new track at `k`: shift existing children at/after it up
      // by one, then drop the inserter into the freshly-opened index.
      const k = insertPlan.target.slot; // ∈ [0, count]
      for (const id of childIds) {
        if (id === insertPlan.nodeId) continue;
        const s = slotOf.get(id);
        if (s !== undefined && s >= k) slotOf.set(id, s + 1);
      }
      slotOf.set(insertPlan.nodeId, k);
    } else {
      // Drop each dragged node into an existing track (a demoted
      // insert-new clamps into range).
      for (const plan of framePlans) {
        const slot =
          plan.target.kind === 'into-existing'
            ? plan.target.slot
            : Math.min(plan.target.slot, count - 1);
        slotOf.set(plan.nodeId, slot);
      }
    }

    // Did the move leave any previously-occupied track empty?
    const newOccupied = new Set(slotOf.values());
    let trackEmptied = false;
    for (const t of origSlot.values()) {
      if (!newOccupied.has(t)) {
        trackEmptied = true;
        break;
      }
    }

    if (insertPlan || trackEmptied) {
      // Compact occupied tracks to a contiguous 0..K-1 range so empty
      // columns / rows are dropped and gridCount tracks the survivors.
      const occupied = [...newOccupied].sort((a, b) => a - b);
      const remap = new Map<number, number>();
      occupied.forEach((track, i) => remap.set(track, i));
      const nextCount = Math.max(FRAME_GRID_MIN_COUNT, occupied.length);

      if (nextCount !== count) {
        out.commands.push({
          type: 'SET_FRAME_LAYOUT',
          frameId: frameId as CanvasNodeId,
          mode: axis as FrameLayoutMode,
          gridCount: nextCount,
        });
        out.frameDataPatches.push({
          nodeId: frameId,
          patch: { layoutMode: axis, gridCount: nextCount },
        });
      }

      const mergePatches: Array<{
        nodeId: CanvasNodeId;
        patch: Record<string, unknown>;
      }> = [];
      for (const id of childIds) {
        const finalSlot = remap.get(slotOf.get(id) ?? 0) ?? 0;
        if (origSlot.get(id) === finalSlot) continue;
        mergePatches.push({
          nodeId: id as CanvasNodeId,
          patch: { frameSlot: finalSlot },
        });
        out.slotPatches.push({ nodeId: id as CanvasNodeId, slot: finalSlot });
      }
      if (mergePatches.length > 0) {
        out.commands.push({ type: 'MERGE_NODE_DATA', patches: mergePatches });
      }
      continue;
    }

    // ── Plain move that doesn't empty its source track: only the
    //    dragged nodes change slot; the grid keeps its current count.
    const slotPatches: Array<{ nodeId: CanvasNodeId; slot: number }> = [];
    for (const plan of framePlans) {
      const slot = slotOf.get(plan.nodeId) ?? 0;
      if (origSlot.get(plan.nodeId) === slot) continue;
      slotPatches.push({ nodeId: plan.nodeId as CanvasNodeId, slot });
    }
    if (slotPatches.length === 0) continue;
    out.commands.push({
      type: 'MERGE_NODE_DATA',
      patches: slotPatches.map((p) => ({
        nodeId: p.nodeId,
        patch: { frameSlot: p.slot },
      })),
    });
    out.slotPatches.push(...slotPatches);
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

/** Absolute rect of a frame, or `null` when its size is unknown. */
function frameAbsRect(
  nodes: Node[],
  frameId: string,
): { x: number; y: number; width: number; height: number } | null {
  const frame = nodes.find((n) => n.id === frameId);
  if (!frame) return null;
  const width =
    (frame.style as { width?: number } | undefined)?.width ??
    (frame.measured as { width?: number } | undefined)?.width;
  const height =
    (frame.style as { height?: number } | undefined)?.height ??
    (frame.measured as { height?: number } | undefined)?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {
    x: absoluteX(nodes, frameId),
    y: absoluteY(nodes, frameId),
    width: width as number,
    height: height as number,
  };
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

/**
 * True when `frameId` is a structured (column / row) frame and `pointer`
 * (flow space) lies within its absolute bounds expanded by `marginX` /
 * `marginY` on each side. The margin (the dragged node's size) makes the
 * outer prepend / append padding reachable when the node's body — and
 * thus the cursor — is dragged slightly past the frame edge, so the
 * drag-stop resolver keeps the node parented instead of unframing on
 * insufficient body-overlap.
 */
function pointerInsideStructuredFrame(
  nodes: Node[],
  frameId: string,
  pointer: { x: number; y: number },
  marginX = 0,
  marginY = 0,
): boolean {
  const frame = nodes.find((n) => n.id === frameId);
  if (!frame || !readFrameGridConfig(frame)) return false;
  const rect = frameAbsRect(nodes, frameId);
  if (!rect) return false;
  return (
    pointer.x >= rect.x - marginX &&
    pointer.x <= rect.x + rect.width + marginX &&
    pointer.y >= rect.y - marginY &&
    pointer.y <= rect.y + rect.height + marginY
  );
}
