/**
 * @file canvasHandlers.ts
 *
 * Pure action handlers for every CanvasCommand variant.
 * The store's `dispatch()` is the single entry point; it reads the current
 * state, builds a CanvasHandlerContext, and delegates to `handleCommand`.
 *
 * Before modifying this file, read the canonical reference first:
 * docs/canvas-commands.md — command table and guide for adding new actions.
 */

import {
  createId,
  type CanvasNodeType,
  type NodeRef,
  type RecentAction,
} from '@sediment/shared';
import { addEdge, type Node, type Edge, type Connection } from '@xyflow/react';

import { canvasHistoryManager } from './canvasHistoryManager';
import { alignNodes, spreadNodes } from '../utils/autoLayoutHelper';
import {
  findFrameAtPoint,
  frameNodes,
  frameNodesInRect,
  getAbsolutePosition,
  toggleFrameLock,
  unframe,
  moveNodeIntoFrame,
  moveNodeOutOfFrame,
  normalizeTreeOrder,
  autoUnframeNodeByNonOverlap,
  autoFrameNodeByOverlap,
  fitFrameToChildren,
  fitFrames,
  type NestableNode,
} from '../utils/frameHelper';
import {
  shouldIngestOnUpdate,
  type NodeIngestionInfo,
} from '../utils/ingestHelper';
import {
  layoutAll as layoutAllNodes,
  layoutGroup as layoutGroupNodes,
  placeNode as placeNewNode,
} from '../utils/layout';
import {
  AUTO_GENERATED_PLACEHOLDER_PATTERN,
  deduplicateLabel,
  generateNextLabel,
} from '../utils/nodeLabels';

import type { CanvasCommand } from './canvasStore';
// ---------------------------------------------------------------------------

/**
 * The minimal slice of store state and capabilities that handlers need.
 * Keeping this narrow prevents circular imports with the full RFState type.
 */
export type CanvasHandlerContext = {
  nodes: Node[];
  edges: Edge[];
  canvasId: string;
  actionHistory: RecentAction[];
  /** Clipboard content — only consumed by PASTE_NODES. */
  clipboard: Node[];
  /** Whether global auto-layout is enabled. */
  autoLayoutEnabled: boolean;
  /**
   * Call `set` exactly once per handler to apply state mutations.
   * Accepts either a partial object or an updater function (for reads of
   * uncommitted state such as ingestionByNodeId).
   */
  set: HandlerSet;
  /**
   * Schedule a debounced knowledge-base ingestion for a node whose content
   * has changed. Must be passed in from the store because the ingestion
   * function holds a reference to `useCanvasStore`.
   */
  triggerIngestion: (node: Node) => void;
};

/** Subset of state that handlers are allowed to mutate via `set`. */
type HandlerSetResult = {
  nodes?: Node[];
  edges?: Edge[];
  actionHistory?: RecentAction[];
  expandedNodeId?: string | null;
  ingestionByNodeId?: Record<string, NodeIngestionInfo>;
};

/** Subset of state readable by the updater form of `set`. */
type HandlerSetState = {
  nodes: Node[];
  edges: Edge[];
  ingestionByNodeId: Record<string, NodeIngestionInfo>;
};

type HandlerSet = (
  partial: HandlerSetResult | ((state: HandlerSetState) => HandlerSetResult),
) => void;

// ---------------------------------------------------------------------------
// Local pure helpers
// ---------------------------------------------------------------------------

/** Extract a lightweight NodeRef from a ReactFlow node. */
export function extractNodeRef(node: Node): NodeRef {
  return {
    id: node.id,
    nodeType: (node.type ?? 'note') as CanvasNodeType,
    label: node.data?.label as string | undefined,
    origin: (node.data as Record<string, unknown> | undefined)
      ?.origin as NodeRef['origin'],
  };
}

/**
 * Extract a short text snippet from a node — first 120 chars of content for
 * note/text nodes, or the src URL for media nodes.
 */
export function extractSnippet(node: Node): string | undefined {
  const data = node.data as Record<string, unknown> | undefined;
  if (!data) return undefined;
  if (
    node.type === 'web' ||
    node.type === 'pdf' ||
    node.type === 'video' ||
    node.type === 'image'
  ) {
    return data.src as string | undefined;
  }
  const content = data.content;
  if (typeof content === 'string' && content.length > 0) {
    return content.slice(0, 120);
  }
  return undefined;
}

/** Append an action to the ring buffer, capping at ACTION_HISTORY_MAX. */
export function pushAction(
  history: RecentAction[],
  action: RecentAction,
  max = 10,
): RecentAction[] {
  const next = [...history, action];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Return a new nodes array where only the nodes whose id is in `selectedIds`
 * are marked selected; all other nodes are deselected.
 */
export function selectOnly(
  nodes: Node[],
  selectedIds: Iterable<string>,
): Node[] {
  const ids = new Set(selectedIds);
  return nodes.map((n) => ({ ...n, selected: ids.has(n.id) }));
}

// ---------------------------------------------------------------------------
// Individual action handlers
// ---------------------------------------------------------------------------

function handleAddNode(
  cmd: Extract<CanvasCommand, { type: 'ADD_NODE' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, actionHistory, set, triggerIngestion } = ctx;
  canvasHistoryManager.takeSnapshot(nodes, edges);

  const existingLabels = nodes.map((n) => n.data?.label as string | undefined);

  let finalLabel = cmd.node.data?.label;
  if (!finalLabel || String(finalLabel).trim() === '') {
    // Try to derive a meaningful label from the node's content or src
    const data = cmd.node.data as Record<string, unknown> | undefined;
    const content = typeof data?.content === 'string' ? data.content : '';
    const src = typeof data?.src === 'string' ? data.src : '';

    if (content.trim()) {
      // Use first non-empty line, up to 50 chars
      finalLabel =
        content
          .split('\n')
          .find((l) => l.trim())
          ?.trim()
          .slice(0, 50) || '';
    } else if (src) {
      // Derive from URL hostname
      try {
        finalLabel = new URL(src).hostname;
      } catch {
        finalLabel = '';
      }
    }

    if (!finalLabel || String(finalLabel).trim() === '') {
      // Still nothing — auto-generate "Image 1", "Note 2", etc.
      finalLabel = generateNextLabel(cmd.node.type || 'node', existingLabels);
    } else {
      finalLabel = deduplicateLabel(String(finalLabel), existingLabels);
    }
  } else {
    // Label provided — deduplicate if it collides with an existing one
    finalLabel = deduplicateLabel(String(finalLabel), existingLabels);
  }

  let newNode: Node = {
    ...cmd.node,
    data: { ...cmd.node.data, label: finalLabel },
  };

  // Auto-detect parent frame based on node position.
  // Only for non-frame nodes that don't already have a parent.
  if (!newNode.parentId && newNode.type !== 'frame') {
    const style = newNode.style as
      | { width?: number; height?: number }
      | undefined;
    const w = typeof style?.width === 'number' ? style.width : 0;
    const h = typeof style?.height === 'number' ? style.height : 0;
    const checkPoint = {
      x: newNode.position.x + w / 2,
      y: newNode.position.y + h / 2,
    };
    const frameId = findFrameAtPoint(nodes as NestableNode[], checkPoint);
    if (frameId) {
      const frameAbs = getAbsolutePosition(nodes as NestableNode[], frameId);
      if (frameAbs) {
        newNode = {
          ...newNode,
          parentId: frameId,
          position: {
            x: newNode.position.x - frameAbs.x,
            y: newNode.position.y - frameAbs.y,
          },
        };
      }
    }
  }

  const updatedNodes = selectOnly(
    normalizeTreeOrder([...nodes, newNode] as NestableNode[]),
    [newNode.id],
  );

  // Check if auto-layout should position this new node
  // Skip auto-layout when the node was explicitly placed (e.g. from toolbar)
  // Auto-layout applies when globally enabled and the parent frame (if any) is not locked
  const parentFrame = newNode.parentId
    ? nodes.find((n) => n.id === newNode.parentId)
    : undefined;
  const parentLocked = parentFrame?.data?.locked === true;
  const shouldAutoPlace =
    !cmd.skipAutoLayout && ctx.autoLayoutEnabled && !parentLocked;

  let finalNodes = updatedNodes;
  if (shouldAutoPlace) {
    const placed = placeNewNode(updatedNodes, edges, newNode.id);
    if (placed) finalNodes = placed;
  }

  // Auto-resize the parent frame to accommodate the new node.
  if (newNode.parentId && ctx.autoLayoutEnabled) {
    finalNodes = fitFrameToChildren(
      finalNodes as NestableNode[],
      newNode.parentId,
    );
  }

  set({
    nodes: finalNodes,
    actionHistory: pushAction(actionHistory, {
      action: 'node_created',
      nodes: [extractNodeRef(newNode)],
    }),
  });

  triggerIngestion(newNode);
}

function handleDeleteNodes(
  cmd: Extract<CanvasCommand, { type: 'DELETE_NODES' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, canvasId, actionHistory, set } = ctx;

  // Expand the deletion set to include all descendants of any deleted frame
  // nodes so that child nodes are not orphaned when their parent is removed.
  const removedIds = new Set(cmd.nodeIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (n.parentId && removedIds.has(n.parentId) && !removedIds.has(n.id)) {
        removedIds.add(n.id);
        changed = true;
      }
    }
  }

  const toDelete = nodes.filter((n) => removedIds.has(n.id));
  if (toDelete.length === 0) return;

  // Collect parent frame IDs of deleted nodes so we can shrink them after.
  const affectedFrameIds = new Set<string>();
  for (const n of toDelete) {
    if (n.parentId && !removedIds.has(n.parentId)) {
      const parent = nodes.find((p) => p.id === n.parentId);
      if (parent?.type === 'frame') affectedFrameIds.add(n.parentId);
    }
  }

  canvasHistoryManager.takeSnapshot(nodes, edges);

  for (const node of toDelete) {
    canvasHistoryManager.trackDelete(canvasId, node.id);
  }

  const nextActions = pushAction(actionHistory, {
    action: 'nodes_deleted',
    nodes: toDelete.map((node) => ({
      ...extractNodeRef(node),
      snippet: extractSnippet(node),
    })),
  });

  set((state) => {
    const nextIngestionByNodeId = { ...state.ingestionByNodeId };
    for (const id of removedIds) delete nextIngestionByNodeId[id];

    let nextNodes = state.nodes.filter((n) => !removedIds.has(n.id));

    // Shrink parent frames that lost children.
    if (affectedFrameIds.size > 0 && ctx.autoLayoutEnabled) {
      nextNodes = fitFrames(nextNodes as NestableNode[], affectedFrameIds);
    }

    return {
      nodes: nextNodes,
      edges: state.edges.filter(
        (e) => !removedIds.has(e.source) && !removedIds.has(e.target),
      ),
      ingestionByNodeId: nextIngestionByNodeId,
      actionHistory: nextActions,
    };
  });
}

function handleConnect(
  cmd: Extract<CanvasCommand, { type: 'CONNECT' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, actionHistory, set } = ctx;
  canvasHistoryManager.takeSnapshot(nodes, edges);

  const sourceNode = nodes.find(
    (n) => n.id === (cmd.connection as Connection).source,
  );
  const targetNode = nodes.find(
    (n) => n.id === (cmd.connection as Connection).target,
  );
  let nextActions = actionHistory;
  if (sourceNode && targetNode) {
    nextActions = pushAction(nextActions, {
      action: 'node_connected',
      source: extractNodeRef(sourceNode),
      target: extractNodeRef(targetNode),
    });
  }

  set({
    edges: addEdge(cmd.connection, edges),
    actionHistory: nextActions,
  });
}

function handleDisconnectEdges(
  cmd: Extract<CanvasCommand, { type: 'DISCONNECT_EDGES' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, actionHistory, set } = ctx;
  canvasHistoryManager.takeSnapshot(nodes, edges);

  const removedEdgeIds = new Set(cmd.edgeIds);

  const disconnectedPairs = cmd.edgeIds.flatMap((edgeId) => {
    const edge = edges.find((e) => e.id === edgeId);
    if (!edge) return [];
    const sourceNode = nodes.find((n) => n.id === edge.source);
    const targetNode = nodes.find((n) => n.id === edge.target);
    if (!sourceNode || !targetNode) return [];
    return [
      {
        source: extractNodeRef(sourceNode),
        target: extractNodeRef(targetNode),
      },
    ];
  });

  const nextActions =
    disconnectedPairs.length > 0
      ? pushAction(actionHistory, {
          action: 'edges_disconnected',
          edges: disconnectedPairs,
        })
      : actionHistory;

  set({
    edges: edges.filter((e) => !removedEdgeIds.has(e.id)),
    actionHistory: nextActions,
  });
}

function handleMoveIntoFrame(
  cmd: Extract<CanvasCommand, { type: 'MOVE_INTO_FRAME' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, actionHistory, set } = ctx;
  canvasHistoryManager.takeSnapshot(nodes, edges);

  const node = nodes.find((n) => n.id === cmd.nodeId);
  const frame = nodes.find((n) => n.id === cmd.frameId);
  let result = moveNodeIntoFrame(
    nodes as NestableNode[],
    cmd.nodeId,
    cmd.frameId,
  );

  // Auto-resize the target frame to fit the newly added child.
  if (ctx.autoLayoutEnabled) {
    result = fitFrameToChildren(result, cmd.frameId);

    // If the node was previously in a different frame, shrink that frame too.
    if (node?.parentId && node.parentId !== cmd.frameId) {
      result = fitFrameToChildren(result, node.parentId);
    }
  }

  let nextActions = actionHistory;
  if (node && frame) {
    nextActions = pushAction(nextActions, {
      action: 'node_framed',
      node: extractNodeRef(node),
      frame: extractNodeRef(frame),
    });
  }

  set({ nodes: result, actionHistory: nextActions });
}

function handleMoveOutOfFrame(
  cmd: Extract<CanvasCommand, { type: 'MOVE_OUT_OF_FRAME' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, actionHistory, set } = ctx;
  canvasHistoryManager.takeSnapshot(nodes, edges);

  const node = nodes.find((n) => n.id === cmd.nodeId);
  const frame = node?.parentId
    ? nodes.find((n) => n.id === node.parentId)
    : undefined;
  let result = moveNodeOutOfFrame(nodes as NestableNode[], cmd.nodeId);

  // Shrink the source frame after losing a child.
  if (frame && ctx.autoLayoutEnabled) {
    result = fitFrameToChildren(result, frame.id);
  }

  let nextActions = actionHistory;
  if (node && frame) {
    nextActions = pushAction(nextActions, {
      action: 'node_unframed',
      node: extractNodeRef(node),
      frame: extractNodeRef(frame),
    });
  }

  set({ nodes: result, actionHistory: nextActions });
}

function handleGroupSelectionIntoFrame(
  _cmd: Extract<CanvasCommand, { type: 'GROUP_SELECTION_INTO_FRAME' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, actionHistory, set } = ctx;
  const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
  if (selectedIds.length < 2) return;

  canvasHistoryManager.takeSnapshot(nodes, edges);
  const frameId = createId('node');
  const result = frameNodes(nodes as NestableNode[], selectedIds, {
    frameId,
    label: 'Frame',
  });

  const frameNode = result.nodes.find((n) => n.id === frameId);
  set({
    nodes: selectOnly(result.nodes, [frameId]),
    actionHistory: frameNode
      ? pushAction(actionHistory, {
          action: 'node_created',
          nodes: [extractNodeRef(frameNode)],
        })
      : actionHistory,
  });
}

function handleGroupRectIntoFrame(
  cmd: Extract<CanvasCommand, { type: 'GROUP_RECT_INTO_FRAME' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, actionHistory, set } = ctx;
  canvasHistoryManager.takeSnapshot(nodes, edges);

  const frameId = createId('node');
  const result = frameNodesInRect(
    nodes as NestableNode[],
    cmd.flowRect,
    frameId,
  );

  const frameNode = result.nodes.find((n) => n.id === frameId);
  set({
    nodes: selectOnly(result.nodes, [frameId]),
    actionHistory: frameNode
      ? pushAction(actionHistory, {
          action: 'node_created',
          nodes: [extractNodeRef(frameNode)],
        })
      : actionHistory,
  });
}

function handleUnframe(
  cmd: Extract<CanvasCommand, { type: 'UNFRAME' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, actionHistory, set } = ctx;
  canvasHistoryManager.takeSnapshot(nodes, edges);

  const frame = nodes.find((n) => n.id === cmd.frameId);
  const children = nodes.filter((n) => n.parentId === cmd.frameId);

  const result = unframe(nodes as NestableNode[], edges, cmd.frameId);

  let nextActions = actionHistory;
  if (frame) {
    nextActions = pushAction(nextActions, {
      action: 'frame_unframed',
      frame: extractNodeRef(frame),
      nodes: children.map(extractNodeRef),
    });
  }

  set({ nodes: result.nodes, edges: result.edges, actionHistory: nextActions });
}

function handleOpenExpanded(
  cmd: Extract<CanvasCommand, { type: 'OPEN_EXPANDED' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, actionHistory, set } = ctx;
  const node = nodes.find((n) => n.id === cmd.nodeId);

  let nextActions = actionHistory;
  if (node) {
    nextActions = pushAction(nextActions, {
      action: 'node_expanded',
      node: extractNodeRef(node),
    });
  }

  set({ expandedNodeId: cmd.nodeId, actionHistory: nextActions });
}

function handleSelectNodes(
  cmd: Extract<CanvasCommand, { type: 'SELECT_NODES' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, actionHistory, set } = ctx;
  const { ids, multiSelect = false } = cmd;

  let nextActions = actionHistory;
  if (!multiSelect && ids.length === 1) {
    const node = nodes.find((n) => n.id === ids[0]);
    if (node) {
      nextActions = pushAction(nextActions, {
        action: 'node_selected',
        node: extractNodeRef(node),
      });
    }
  } else if (multiSelect && ids.length > 0) {
    const selectedNodes = ids
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
      .map(extractNodeRef);
    if (selectedNodes.length > 0) {
      nextActions = pushAction(nextActions, {
        action: 'nodes_selected',
        nodes: selectedNodes,
      });
    }
  }

  set((state) => ({
    nodes: state.nodes.map((node) => {
      if (multiSelect) {
        const isTarget = ids.includes(node.id);
        return isTarget ? { ...node, selected: !node.selected } : node;
      }
      return { ...node, selected: ids.includes(node.id) };
    }),
    actionHistory: nextActions,
  }));
}

function handleResizeNode(
  cmd: Extract<CanvasCommand, { type: 'RESIZE_NODE' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, actionHistory, set } = ctx;
  // The undo snapshot is always taken by the caller before the drag gesture
  // begins (via store.takeSnapshot()), so the handler never snapshots here.
  const node = nodes.find((n) => n.id === cmd.nodeId);
  let nextActions = actionHistory;
  if (node) {
    nextActions = pushAction(nextActions, {
      action: 'node_resized',
      node: extractNodeRef(node),
      width: cmd.width,
      height: cmd.height,
    });
  }
  let updatedNodes = nodes.map((n) =>
    n.id === cmd.nodeId
      ? { ...n, style: { ...n.style, width: cmd.width, height: cmd.height } }
      : n,
  );

  // If the resized node is inside a frame, auto-fit the parent frame.
  if (node?.parentId && ctx.autoLayoutEnabled) {
    const parent = nodes.find((p) => p.id === node.parentId);
    if (parent?.type === 'frame') {
      updatedNodes = fitFrameToChildren(
        updatedNodes as NestableNode[],
        node.parentId,
      );
    }
  }

  set({
    nodes: updatedNodes,
    actionHistory: nextActions,
  });
}

function handleUpdateNodeData(
  cmd: Extract<CanvasCommand, { type: 'UPDATE_NODE_DATA' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, actionHistory, set, triggerIngestion } = ctx;

  // Guard: nothing to do if the target node does not exist.
  const originalNode = nodes.find((n) => n.id === cmd.nodeId);
  if (!originalNode) return;

  // Always take a snapshot — every UPDATE_NODE_DATA represents a confirmed
  // user edit. Silent background writes go through patchNodeSilent instead.
  canvasHistoryManager.takeSnapshot(nodes, edges);

  const updatedNode: Node = {
    ...originalNode,
    data: { ...(originalNode.data ?? {}), ...cmd.patch },
  };

  set({
    nodes: nodes.map((n) => (n.id === cmd.nodeId ? updatedNode : n)),
    actionHistory: pushAction(actionHistory, {
      action: 'node_edited',
      node: extractNodeRef(updatedNode),
    }),
  });

  if (shouldIngestOnUpdate(originalNode, updatedNode)) {
    triggerIngestion(updatedNode);
  }
}

function handleToggleFrameLock(
  cmd: Extract<CanvasCommand, { type: 'TOGGLE_FRAME_LOCK' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, set } = ctx;
  canvasHistoryManager.takeSnapshot(nodes, edges);
  set({ nodes: toggleFrameLock(nodes as NestableNode[], cmd.frameId) });
}

function handleReorderNodes(
  cmd: Extract<CanvasCommand, { type: 'REORDER_NODES' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, actionHistory, set } = ctx;

  if ('position' in cmd) {
    // Move a set of nodes to the absolute top or bottom of the render stack.
    const movedIds = new Set(cmd.nodeIds);
    const moved = nodes.filter((n) => movedIds.has(n.id));
    // Guard before snapshot: nothing to do if no matching nodes.
    if (moved.length === 0) return;
    canvasHistoryManager.takeSnapshot(nodes, edges);
    const rest = nodes.filter((n) => !movedIds.has(n.id));
    const reordered =
      cmd.position === 'top' ? [...rest, ...moved] : [...moved, ...rest];
    set({
      nodes: normalizeTreeOrder(reordered as NestableNode[]),
      actionHistory: pushAction(actionHistory, {
        action: 'nodes_reordered',
        nodes: moved.map(extractNodeRef),
      }),
    });
  } else {
    // Swap two nodes by their drag-and-drop positions.
    const oldIndex = nodes.findIndex((n) => n.id === cmd.activeId);
    const newIndex = nodes.findIndex((n) => n.id === cmd.overId);
    // Guard before snapshot: nothing to do if either node is missing.
    if (oldIndex === -1 || newIndex === -1) return;
    canvasHistoryManager.takeSnapshot(nodes, edges);
    const reordered = [...nodes];
    const [movedItem] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, movedItem);
    const affectedNodes = [nodes[oldIndex], nodes[newIndex]].filter(Boolean);
    set({
      nodes: normalizeTreeOrder(reordered as NestableNode[]),
      actionHistory: pushAction(actionHistory, {
        action: 'nodes_reordered',
        nodes: affectedNodes.map(extractNodeRef),
      }),
    });
  }
}

function handlePasteNodes(
  cmd: Extract<CanvasCommand, { type: 'PASTE_NODES' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, clipboard, actionHistory, set, triggerIngestion } = ctx;
  if (clipboard.length === 0) return;

  canvasHistoryManager.takeSnapshot(nodes, edges);

  // Compute paste offset: centre the group on flowPosition if provided,
  // otherwise apply a fixed diagonal nudge so the paste is visually distinct.
  // Only consider root-level nodes (no parentId) for the bounding box,
  // because children have frame-relative positions.
  let offsetX: number;
  let offsetY: number;

  const rootNodes = clipboard.filter((n) => !n.parentId);
  const bboxNodes = rootNodes.length > 0 ? rootNodes : clipboard;

  if (cmd.flowPosition) {
    const xs = bboxNodes.map((n) => n.position.x);
    const ys = bboxNodes.map((n) => n.position.y);
    const widths = bboxNodes.map(
      (n) => (n.style?.width as number) ?? n.measured?.width ?? 200,
    );
    const heights = bboxNodes.map(
      (n) => (n.style?.height as number) ?? n.measured?.height ?? 150,
    );
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs.map((x, i) => x + widths[i]));
    const maxY = Math.max(...ys.map((y, i) => y + heights[i]));
    offsetX = cmd.flowPosition.x - (minX + maxX) / 2;
    offsetY = cmd.flowPosition.y - (minY + maxY) / 2;
  } else {
    const OFFSET = 40;
    offsetX = OFFSET;
    offsetY = OFFSET;
  }

  // Build old-id → new-id map so parentId refs stay consistent.
  const idMap = new Map<string, string>();
  for (const node of clipboard) {
    idMap.set(node.id, createId('node'));
  }

  const existingLabels = nodes.map((n) => n.data?.label as string | undefined);

  const newNodes: Node[] = clipboard.map((node) => {
    const newId = idMap.get(node.id) ?? createId('node');

    // For pasted nodes: keep custom labels (deduplicated), regenerate auto-generated ones.
    const originalLabel = String(node.data?.label ?? '').trim();
    const isAutoLabel =
      !originalLabel || AUTO_GENERATED_PLACEHOLDER_PATTERN.test(originalLabel);
    const label = isAutoLabel
      ? generateNextLabel(node.type || 'node', existingLabels)
      : deduplicateLabel(originalLabel, existingLabels);
    existingLabels.push(label);

    const clonedData = JSON.parse(JSON.stringify(node.data ?? {}));
    delete clonedData.sourceId;
    delete clonedData.sourceBackend;

    const cloned: Node = {
      id: newId,
      type: node.type,
      // Only apply the offset to root-level nodes. Children keep their
      // frame-relative positions so the layout inside frames is preserved.
      position:
        node.parentId && idMap.has(node.parentId)
          ? { x: node.position.x, y: node.position.y }
          : { x: node.position.x + offsetX, y: node.position.y + offsetY },
      data: {
        ...clonedData,
        label,
      },
      ...(node.style ? { style: JSON.parse(JSON.stringify(node.style)) } : {}),
    };

    if (node.parentId && idMap.has(node.parentId)) {
      cloned.parentId = idMap.get(node.parentId);
    }

    return cloned;
  });

  // Auto-detect parent frame for pasted nodes without a remapped parent.
  const finalNodes: Node[] = newNodes.map((n) => {
    if (n.parentId) return n; // Already has a parent from clipboard remap
    if (n.type === 'frame') return n; // Don't nest frames

    const style = n.style as { width?: number; height?: number } | undefined;
    const w = typeof style?.width === 'number' ? style.width : 0;
    const h = typeof style?.height === 'number' ? style.height : 0;
    const checkPoint = {
      x: n.position.x + w / 2,
      y: n.position.y + h / 2,
    };

    const frameId = findFrameAtPoint(nodes as NestableNode[], checkPoint);
    if (!frameId) return n;

    const frameAbs = getAbsolutePosition(nodes as NestableNode[], frameId);
    if (!frameAbs) return n;

    return {
      ...n,
      parentId: frameId,
      position: {
        x: n.position.x - frameAbs.x,
        y: n.position.y - frameAbs.y,
      },
    };
  });

  // Tag every pasted node so the agent knows this batch came from a paste gesture.
  const taggedNodes: Node[] = finalNodes.map((n) => ({
    ...n,
    data: {
      ...(n.data as Record<string, unknown>),
      origin: { type: 'user-pasted' },
    },
  }));

  // Collect frames that received pasted nodes so we can resize them.
  const pastedFrameIds = new Set<string>();
  for (const n of taggedNodes) {
    if (n.parentId) pastedFrameIds.add(n.parentId);
  }

  let pastedResult = normalizeTreeOrder([
    ...nodes,
    ...taggedNodes,
  ] as NestableNode[]);

  // Auto-resize frames that received pasted children.
  if (pastedFrameIds.size > 0 && ctx.autoLayoutEnabled) {
    pastedResult = fitFrames(pastedResult, pastedFrameIds);
  }

  set({
    nodes: selectOnly(
      pastedResult,
      taggedNodes.map((n) => n.id),
    ),
    actionHistory: pushAction(actionHistory, {
      action: 'node_created',
      nodes: taggedNodes.map(extractNodeRef),
    }),
  });

  for (const node of taggedNodes) {
    triggerIngestion(node);
  }
}

function handleAlignNodes(
  cmd: Extract<CanvasCommand, { type: 'ALIGN_NODES' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, set } = ctx;
  let result = alignNodes(nodes, cmd.direction);
  if (!result) return;

  canvasHistoryManager.takeSnapshot(nodes, edges);

  // Resize affected parent frames when auto-layout is enabled.
  if (ctx.autoLayoutEnabled) {
    const affectedFrameIds = new Set<string>();
    for (const n of result) {
      if (n.selected && n.parentId) affectedFrameIds.add(n.parentId);
    }
    if (affectedFrameIds.size > 0) {
      result = fitFrames(result as NestableNode[], affectedFrameIds);
    }
  }

  set({ nodes: result });
}

function handleSpreadNodes(
  _cmd: Extract<CanvasCommand, { type: 'SPREAD_NODES' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, set } = ctx;
  let result = spreadNodes(nodes);
  if (!result) return;

  canvasHistoryManager.takeSnapshot(nodes, edges);

  // Resize affected parent frames when auto-layout is enabled.
  if (ctx.autoLayoutEnabled) {
    const affectedFrameIds = new Set<string>();
    for (const n of result) {
      if (n.selected && n.parentId) affectedFrameIds.add(n.parentId);
    }
    if (affectedFrameIds.size > 0) {
      result = fitFrames(result as NestableNode[], affectedFrameIds);
    }
  }

  set({ nodes: result });
}

// --------------- Layout handlers ---------------

function handleLayoutAll(
  _cmd: Extract<CanvasCommand, { type: 'LAYOUT_ALL' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, set } = ctx;
  canvasHistoryManager.takeSnapshot(nodes, edges);
  const result = layoutAllNodes(nodes, edges, { animate: true });
  if (!result) return;
  set({ nodes: result });
}

function handleLayoutGroup(
  cmd: Extract<CanvasCommand, { type: 'LAYOUT_GROUP' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, set } = ctx;
  canvasHistoryManager.takeSnapshot(nodes, edges);
  const result = layoutGroupNodes(nodes, edges, cmd.frameId, { animate: true });
  if (!result) return;
  // Resize the frame to tightly wrap its newly laid-out children.
  const fitted = fitFrameToChildren(result as NestableNode[], cmd.frameId);
  set({ nodes: fitted });
}

function handleNodeDragStop(
  cmd: Extract<CanvasCommand, { type: 'NODE_DRAG_STOP' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, actionHistory, set } = ctx;

  // Snapshot is already taken in onNodeDragStart before the gesture begins.
  // Do NOT snapshot here — the whole drag collapses into one undo entry.

  // Capture parentId before auto-frame mutation so we can diff afterwards.
  const preParentIds = new Map(nodes.map((n) => [n.id, n.parentId]));

  const draggedIds = new Set(cmd.draggedNodeIds);

  // Apply auto-frame / auto-unframe for every dragged node.
  let result = nodes as NestableNode[];
  for (const id of cmd.draggedNodeIds) {
    result = autoUnframeNodeByNonOverlap(result, id, {
      epsilon: 0,
      margin: 10,
    });
    result = autoFrameNodeByOverlap(result, id, { threshold: 0.5 });
  }

  if (result === nodes) {
    // Positions changed (handled by onNodesChange already) but no structural
    // re-parenting happened. Still fit frames whose children may have moved
    // beyond their current boundary, then push a nodes_moved trace.
    const inFrameIds = new Set<string>();
    for (const id of cmd.draggedNodeIds) {
      const node = nodes.find((n) => n.id === id);
      if (node?.parentId) inFrameIds.add(node.parentId);
    }
    const draggedNodes = nodes.filter((n) => draggedIds.has(n.id));
    if (inFrameIds.size > 0 && ctx.autoLayoutEnabled) {
      const fitted = fitFrames(nodes as NestableNode[], inFrameIds);
      set({
        nodes: fitted,
        actionHistory:
          draggedNodes.length > 0
            ? pushAction(actionHistory, {
                action: 'nodes_moved',
                nodes: draggedNodes.map(extractNodeRef),
              })
            : actionHistory,
      });
      return;
    }
    if (draggedNodes.length === 0) return;
    set({
      actionHistory: pushAction(actionHistory, {
        action: 'nodes_moved',
        nodes: draggedNodes.map(extractNodeRef),
      }),
    });
    return;
  }

  // Build frame-change traces.
  let nextActions = actionHistory;
  for (const id of cmd.draggedNodeIds) {
    const node = result.find((n) => n.id === id);
    if (!node) continue;

    const prevParentId = preParentIds.get(id);
    const nextParentId = node.parentId;

    if (prevParentId !== nextParentId) {
      if (nextParentId) {
        // Node gained a parent → auto-framed.
        const frame = result.find((n) => n.id === nextParentId);
        if (frame) {
          nextActions = pushAction(nextActions, {
            action: 'node_framed',
            node: extractNodeRef(node),
            frame: extractNodeRef(frame),
          });
        }
      } else {
        // Node lost its parent → auto-unframed.
        const frame = nodes.find((n) => n.id === prevParentId);
        if (frame) {
          nextActions = pushAction(nextActions, {
            action: 'node_unframed',
            node: extractNodeRef(node),
            frame: extractNodeRef(frame),
          });
        }
      }
    }
  }

  // Auto-resize all frames that gained or lost children.
  const affectedFrameIds = new Set<string>();
  for (const id of cmd.draggedNodeIds) {
    const prevParentId = preParentIds.get(id);
    const node = result.find((n) => n.id === id);
    const nextParentId = node?.parentId;
    if (prevParentId) affectedFrameIds.add(prevParentId);
    if (nextParentId) affectedFrameIds.add(nextParentId);
  }
  // Also fit frames whose children were moved within them (child may now
  // extend beyond the frame boundary after being dragged inside).
  for (const id of cmd.draggedNodeIds) {
    const node = result.find((n) => n.id === id);
    if (node?.parentId) affectedFrameIds.add(node.parentId);
  }
  if (affectedFrameIds.size > 0 && ctx.autoLayoutEnabled) {
    result = fitFrames(result, affectedFrameIds);
  }

  // Always push a nodes_moved trace for the dragged nodes.
  const draggedNodes = result.filter((n) => draggedIds.has(n.id));
  if (draggedNodes.length > 0) {
    nextActions = pushAction(nextActions, {
      action: 'nodes_moved',
      nodes: draggedNodes.map(extractNodeRef),
    });
  }

  set({ nodes: result, actionHistory: nextActions });
}

// ---------------------------------------------------------------------------
// Main dispatcher — called by canvasStore's dispatch()
// ---------------------------------------------------------------------------

export function handleCommand(
  cmd: CanvasCommand,
  ctx: CanvasHandlerContext,
): void {
  switch (cmd.type) {
    case 'ADD_NODE':
      return handleAddNode(cmd, ctx);
    case 'DELETE_NODES':
      return handleDeleteNodes(cmd, ctx);
    case 'CONNECT':
      return handleConnect(cmd, ctx);
    case 'DISCONNECT_EDGES':
      return handleDisconnectEdges(cmd, ctx);
    case 'MOVE_INTO_FRAME':
      return handleMoveIntoFrame(cmd, ctx);
    case 'MOVE_OUT_OF_FRAME':
      return handleMoveOutOfFrame(cmd, ctx);
    case 'GROUP_SELECTION_INTO_FRAME':
      return handleGroupSelectionIntoFrame(cmd, ctx);
    case 'GROUP_RECT_INTO_FRAME':
      return handleGroupRectIntoFrame(cmd, ctx);
    case 'UNFRAME':
      return handleUnframe(cmd, ctx);
    case 'OPEN_EXPANDED':
      return handleOpenExpanded(cmd, ctx);
    case 'SELECT_NODES':
      return handleSelectNodes(cmd, ctx);
    case 'RESIZE_NODE':
      return handleResizeNode(cmd, ctx);
    case 'UPDATE_NODE_DATA':
      return handleUpdateNodeData(cmd, ctx);
    case 'TOGGLE_FRAME_LOCK':
      return handleToggleFrameLock(cmd, ctx);
    case 'REORDER_NODES':
      return handleReorderNodes(cmd, ctx);
    case 'PASTE_NODES':
      return handlePasteNodes(cmd, ctx);
    case 'ALIGN_NODES':
      return handleAlignNodes(cmd, ctx);
    case 'SPREAD_NODES':
      return handleSpreadNodes(cmd, ctx);
    case 'LAYOUT_ALL':
      return handleLayoutAll(cmd, ctx);
    case 'LAYOUT_GROUP':
      return handleLayoutGroup(cmd, ctx);
    case 'NODE_DRAG_STOP':
      return handleNodeDragStop(cmd, ctx);
  }
}
