import {
  autoFrameNodeByOverlap,
  autoUnframeNodeByNonOverlap,
  fitFrames,
  pickColumnSlotFromFramePoint,
  pickRowSlotFromFramePoint,
  readFrameGridConfig,
  type NestableNode,
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
    result = autoUnframeNodeByNonOverlap(result, id, {
      epsilon: 0,
      margin: 10,
    });
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

  const cellsSlotPatches = collectGridSlotPatches(
    intent.draggedNodeIds,
    result,
    ui.nodes,
    intent.pointerFlowPosition,
  );

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
    pushSlotCommand(commands, cellsSlotPatches);
    commands.push(
      ...buildStructuredFrameRelayoutCommands(affectedFrameIds, result, {
        slotPatches: cellsSlotPatches.map((p) => ({
          nodeId: p.nodeId,
          slot: p.slot,
        })),
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

  pushSlotCommand(commands, cellsSlotPatches);
  commands.push(
    ...buildStructuredFrameRelayoutCommands(affectedFrameIds, result, {
      slotPatches: cellsSlotPatches.map((p) => ({
        nodeId: p.nodeId,
        slot: p.slot,
      })),
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

interface GridSlotPatch {
  nodeId: CanvasNodeId;
  slot: number;
}

/**
 * For each dragged node that lands inside a structured frame, pick the
 * slot it should occupy based on the drop point:
 *
 *  - Column masonry → the column under the cursor (mouse X).
 *  - Row masonry    → the row under the cursor (mouse Y).
 *
 * Falls back to the child's own top-left when the cursor isn't
 * available (programmatic emits, touch). All dragged nodes in a
 * multi-select share the same cursor point — matches ReactFlow's
 * single-cursor model.
 *
 * Returns at most one patch per dragged node, and only when the new
 * slot differs from the stored one (avoids no-op `MERGE_NODE_DATA`
 * rounds).
 */
function collectGridSlotPatches(
  draggedIds: string[],
  postDragNodes: NestableNode[],
  preDragNodes: Node[],
  pointerFlowPosition?: { x: number; y: number },
): GridSlotPatch[] {
  const patches: GridSlotPatch[] = [];
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

    const slot =
      cfg.axis === 'column'
        ? pickColumnSlotFromFramePoint(
            preDragNodes,
            frame.id,
            framePoint,
            id,
            cfg.count,
          )
        : pickRowSlotFromFramePoint(
            preDragNodes,
            frame.id,
            framePoint,
            id,
            cfg.count,
          );

    const prior = (post.data as { frameSlot?: number } | undefined)?.frameSlot;
    if (typeof prior === 'number' && prior === slot) continue;

    patches.push({ nodeId: id as CanvasNodeId, slot });
  }
  return patches;
}

function pushSlotCommand(
  commands: CanvasCommand[],
  patches: GridSlotPatch[],
): void {
  if (patches.length === 0) return;
  commands.push({
    type: 'MERGE_NODE_DATA',
    patches: patches.map((p) => ({
      nodeId: p.nodeId,
      patch: { frameSlot: p.slot },
    })),
  });
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
