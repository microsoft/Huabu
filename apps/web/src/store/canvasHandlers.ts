/**
 * @file canvasHandlers.ts
 *
 * Pure action handlers for every CanvasCommand variant.
 * The store's `dispatch()` is the single entry point; it reads the current
 * state, builds a CanvasHandlerContext, and delegates to `handleCommand`.
 *
 * ---------------------------------------------------------------------------
 * HOW TO ADD A NEW ACTION
 * ---------------------------------------------------------------------------
 * 1. **Define the command shape** in the `CanvasCommand` union (canvasStore.ts).
 *    Use clear, verb-noun naming: VERB_SUBJECT (e.g. DELETE_NODES, RESIZE_NODE).
 *
 * 2. **Add a handler function** below following the existing pattern:
 *    - Accept `(cmd: Extract<CanvasCommand, { type: 'YOUR_TYPE' }>, ctx: CanvasHandlerContext)`
 *    - Take an undo snapshot with `canvasHistoryManager.takeSnapshot` (or
 *      `takeResizeSnapshot` for resize operations) BEFORE mutating state.
 *    - Record an agent-readable entry in `actionHistory` via `pushAction` so
 *      the AI agent has context about recent user activity.
 *    - Call `ctx.set(...)` once at the end — multiple `set` calls cause extra
 *      re-renders and can break the autosave middleware diffing.
 *    - If the action creates or modifies node content that needs to be indexed
 *      in the knowledge base, call `ctx.triggerIngestion(node)` after `set`.
 *
 * 3. **Add the case** to the `switch` in `handleCommand` and call your function.
 *
 * 4. **Expose a public store method** in `canvasStore.ts` (RFState + implementation)
 *    that calls `get().dispatch({ type: 'YOUR_TYPE', ... })`.
 *
 * 5. Guard clauses belong in the handler (e.g. early `break` when there is
 *    nothing to do), not in the public store method.
 * ---------------------------------------------------------------------------
 */

import {
  createId,
  type CanvasNodeType,
  type NodeRef,
  type RecentAction,
} from '@sediment/shared';
import { addEdge, type Node, type Edge, type Connection } from '@xyflow/react';

import { canvasHistoryManager } from './canvasHistoryManager';
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
  type NestableNode,
} from '../utils/frameHelper';
import { generateNextLabel } from '../utils/nodeLabels';

import type { CanvasCommand } from './canvasStore';
import type { NodeIngestionInfo } from '../utils/ingestHelper';

// ---------------------------------------------------------------------------
// Context passed from the store into every handler
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

  let finalLabel = cmd.node.data?.label;
  if (!finalLabel || String(finalLabel).trim() === '') {
    finalLabel = generateNextLabel(
      cmd.node.type || 'node',
      nodes.map((n) => n.data?.label as string | undefined),
    );
  }

  let newNode: Node = {
    ...cmd.node,
    data: { ...cmd.node.data, label: finalLabel },
  };

  // Auto-detect parent frame based on node position.
  // Only for non-frame nodes that don't already have a parent.
  if (!newNode.parentId && newNode.type !== 'frame') {
    const style = newNode.style as { width?: number; height?: number } | undefined;
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

  set({
    nodes: selectOnly(
      normalizeTreeOrder([...nodes, newNode] as NestableNode[]),
      [newNode.id],
    ),
    actionHistory: pushAction(actionHistory, {
      action: 'node_created',
      node: extractNodeRef(newNode),
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
  canvasHistoryManager.takeSnapshot(nodes, edges);

  let nextActions = actionHistory;
  for (const node of toDelete) {
    canvasHistoryManager.trackDelete(canvasId, node.id);
    nextActions = pushAction(nextActions, {
      action: 'node_deleted',
      node: extractNodeRef(node),
      snippet: extractSnippet(node),
    });
  }

  set((state) => {
    const nextIngestionByNodeId = { ...state.ingestionByNodeId };
    for (const id of removedIds) delete nextIngestionByNodeId[id];
    return {
      nodes: state.nodes.filter((n) => !removedIds.has(n.id)),
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
  let nextActions = actionHistory;
  for (const edgeId of cmd.edgeIds) {
    const edge = edges.find((e) => e.id === edgeId);
    if (edge) {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      const targetNode = nodes.find((n) => n.id === edge.target);
      if (sourceNode && targetNode) {
        nextActions = pushAction(nextActions, {
          action: 'node_disconnected',
          source: extractNodeRef(sourceNode),
          target: extractNodeRef(targetNode),
        });
      }
    }
  }

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
  const result = moveNodeIntoFrame(
    nodes as NestableNode[],
    cmd.nodeId,
    cmd.frameId,
  );

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
  const result = moveNodeOutOfFrame(nodes as NestableNode[], cmd.nodeId);

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
          node: extractNodeRef(frameNode),
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
          node: extractNodeRef(frameNode),
        })
      : actionHistory,
  });
}

function handleUnframe(
  cmd: Extract<CanvasCommand, { type: 'UNFRAME' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, set } = ctx;
  canvasHistoryManager.takeSnapshot(nodes, edges);

  const result = unframe(nodes as NestableNode[], edges, cmd.frameId);
  set({ nodes: result.nodes, edges: result.edges });
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
  const { nodes, edges, set } = ctx;
  // Skip snapshot when the caller (NodeWrapper.handleResizeStart) already
  // took one before the drag began, so the whole drag is a single undo entry.
  if (!cmd.skipSnapshot) {
    canvasHistoryManager.takeResizeSnapshot(cmd.nodeId, nodes, edges);
  }

  set({
    nodes: nodes.map((n) =>
      n.id === cmd.nodeId
        ? { ...n, style: { ...n.style, width: cmd.width, height: cmd.height } }
        : n,
    ),
  });
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
  const { nodes, edges, set } = ctx;

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
    set({ nodes: normalizeTreeOrder(reordered as NestableNode[]) });
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
    set({ nodes: normalizeTreeOrder(reordered as NestableNode[]) });
  }
}

function handlePasteNodes(
  cmd: Extract<CanvasCommand, { type: 'PASTE_NODES' }>,
  ctx: CanvasHandlerContext,
): void {
  const { nodes, edges, clipboard, set, triggerIngestion } = ctx;
  if (clipboard.length === 0) return;

  canvasHistoryManager.takeSnapshot(nodes, edges);

  // Compute paste offset: centre the group on flowPosition if provided,
  // otherwise apply a fixed diagonal nudge so the paste is visually distinct.
  let offsetX: number;
  let offsetY: number;

  if (cmd.flowPosition) {
    const xs = clipboard.map((n) => n.position.x);
    const ys = clipboard.map((n) => n.position.y);
    const widths = clipboard.map(
      (n) => (n.style?.width as number) ?? n.measured?.width ?? 200,
    );
    const heights = clipboard.map(
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
    const label = generateNextLabel(node.type || 'node', existingLabels);
    existingLabels.push(label);

    const cloned: Node = {
      id: newId,
      type: node.type,
      position: {
        x: node.position.x + offsetX,
        y: node.position.y + offsetY,
      },
      data: {
        ...JSON.parse(JSON.stringify(node.data ?? {})),
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

  set({
    nodes: selectOnly(
      normalizeTreeOrder([...nodes, ...finalNodes] as NestableNode[]),
      finalNodes.map((n) => n.id),
    ),
  });

  for (const node of finalNodes) {
    triggerIngestion(node);
  }
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
    case 'TOGGLE_FRAME_LOCK':
      return handleToggleFrameLock(cmd, ctx);
    case 'REORDER_NODES':
      return handleReorderNodes(cmd, ctx);
    case 'PASTE_NODES':
      return handlePasteNodes(cmd, ctx);
  }
}
