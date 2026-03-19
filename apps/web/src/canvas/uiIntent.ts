/**
 * Web-only UI intent types and resolvers.
 *
 * A CanvasUiIntent represents a high-level user gesture that must be resolved
 * into explicit CanvasCommand(s) before execution. Resolution reads UI-only
 * state (selection, clipboard, drag context) and produces a CanvasExecution.
 *
 * Every user-facing action flows through an intent so that trace generation
 * happens uniformly at the intent level (not inside command handlers).
 */

import {
  createId,
  type CanvasAlignDirection,
  type CanvasCommand,
  type CanvasEdgeId,
  type CanvasNodeId,
  type CanvasSize,
  type CanvasNodeType,
  type Point,
  type RecentAction,
} from '@sediment/shared';

import { extractNodeRef, extractSnippet } from './utils';
import {
  autoFrameNodeByOverlap,
  autoUnframeNodeByNonOverlap,
  findFrameAtPoint,
  frameNodes,
  frameNodesInRect,
  fitFrames,
  getAbsolutePosition,
  type NestableNode,
} from './utils/frame';
import { computeMediaSize } from '../utils/node/factory';
import { deduplicateLabel, generateNextLabel } from '../utils/node/labels';
import { nodePositionFromPlacementPoint } from '../utils/node/placement';

import type { Edge, Node } from '@xyflow/react';

// ---------------------------------------------------------------------------
// Flow rect
// ---------------------------------------------------------------------------

export interface CanvasFlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasUiSelectionMode = 'replace' | 'toggle';

export interface AddNodeInput {
  id?: CanvasNodeId;
  nodeType: CanvasNodeType;
  data?: Record<string, unknown>;
  size?: CanvasSize;
  naturalDimensions?: { width: number; height: number };
  parentId?: CanvasNodeId | null;
  /** Explicit placement anchor used for centering and frame hit-testing. */
  placementPoint?: Point;
  skipAutoLayout?: boolean;
}

// ---------------------------------------------------------------------------
// UiIntent union
// ---------------------------------------------------------------------------

export type CanvasUiIntent =
  // --- Composite gestures (need resolvers) ---
  | { type: 'GROUP_SELECTION_INTO_FRAME'; frameLabel?: string }
  | {
      type: 'GROUP_RECT_INTO_FRAME';
      flowRect: CanvasFlowRect;
      frameLabel?: string;
    }
  | { type: 'PASTE_CLIPBOARD'; flowPosition?: Point }
  | { type: 'NODE_DRAG_STOP'; draggedNodeIds: string[] }
  | {
      type: 'SELECT_NODES';
      nodeIds: string[];
      mode?: CanvasUiSelectionMode;
    }
  | {
      type: 'ALIGN_SELECTED_NODES';
      direction: CanvasAlignDirection;
    }
  | {
      type: 'DISTRIBUTE_SELECTED_NODES';
    }
  | {
      type: 'REORDER_SELECTED_NODES';
      to: 'top' | 'bottom';
    }
  // --- Direct-mapping intents (operands are already explicit) ---
  | {
      type: 'ADD_NODES';
      inputs: AddNodeInput[];
    }
  | { type: 'DELETE_NODES'; nodeIds: string[] }
  | { type: 'UPDATE_NODE_DATA'; nodeId: string; patch: Record<string, unknown> }
  | { type: 'CONNECT_EDGE'; source: string; target: string }
  | { type: 'DISCONNECT_EDGE'; edgeIds: string[] }
  | {
      type: 'RESIZE_NODE';
      items: Array<{
        nodeId: string;
        size?: { width: number; height: number };
        position?: { x: number; y: number };
      }>;
    }
  | { type: 'REORDER_NODE'; activeId: string; overId: string }
  | { type: 'DISSOLVE_FRAME'; frameId: string }
  | { type: 'TOGGLE_NODE_LOCK'; nodeId: string }
  | { type: 'LAYOUT_ALL' }
  | { type: 'LAYOUT_GROUP'; frameId: string }
  | { type: 'MOVE_NODE_INTO_FRAME'; nodeId: string; frameId: string }
  | { type: 'MOVE_NODE_OUT_OF_FRAME'; nodeId: string }
  | { type: 'EXPAND_NODE'; nodeId: string };

// ---------------------------------------------------------------------------
// Resolver result — commands + trace
// ---------------------------------------------------------------------------

export interface UiIntentResolution {
  commands: CanvasCommand[];
  /** Trace entries to record for this intent. */
  trace: RecentAction[];
}

// ---------------------------------------------------------------------------
// UI state slice needed by resolvers
// ---------------------------------------------------------------------------

export interface UiResolverState {
  nodes: Node[];
  edges: Edge[];
  clipboard: Node[];
}

const DEFAULT_PASTE_OFFSET = 40;

function canvasSizeFromStyle(
  style: Node['style'] | undefined,
): CanvasSize | undefined {
  const styleRecord = style as Record<string, unknown> | undefined;
  const width = styleRecord?.width;
  if (typeof width !== 'number') return undefined;

  const height = styleRecord?.height;
  return typeof height === 'number' ? { width, height } : { width };
}

function resolveExplicitFramePlacement(params: {
  nodes: Node[];
  nodeType: CanvasNodeType;
  position?: Point;
  placementPoint?: Point;
  parentId?: CanvasNodeId | null;
}): { position?: Point; parentId?: CanvasNodeId | null } {
  const { nodes, nodeType, position, placementPoint, parentId } = params;

  if (!position || !placementPoint || parentId || nodeType === 'frame') {
    return { position, parentId };
  }

  const frameId = findFrameAtPoint(nodes as NestableNode[], placementPoint);
  if (!frameId) {
    return { position, parentId };
  }

  const frameAbs = getAbsolutePosition(nodes as NestableNode[], frameId);
  if (!frameAbs) {
    return { position, parentId };
  }

  return {
    parentId: frameId as CanvasNodeId,
    position: {
      x: position.x - frameAbs.x,
      y: position.y - frameAbs.y,
    },
  };
}

function resolveAddNodePlacement(input: AddNodeInput): {
  position?: Point;
  size?: CanvasSize;
} {
  const size =
    input.size ??
    (input.naturalDimensions &&
    (input.nodeType === 'image' || input.nodeType === 'video')
      ? computeMediaSize(
          input.nodeType,
          input.naturalDimensions.width,
          input.naturalDimensions.height,
        )
      : undefined);

  return {
    position: input.placementPoint
      ? nodePositionFromPlacementPoint(
          input.placementPoint,
          input.nodeType,
          size,
        )
      : undefined,
    size,
  };
}

function materializeAddNode(
  input: AddNodeInput,
  ui: UiResolverState,
): {
  node: Extract<CanvasCommand, { type: 'CREATE_NODES' }>['nodes'][number];
  traceNode: {
    id: CanvasNodeId;
    nodeType: CanvasNodeType;
    label?: string;
  };
} {
  const nodeId = input.id ?? createId('node');
  const placement = resolveAddNodePlacement(input);
  const resolved = resolveExplicitFramePlacement({
    nodes: ui.nodes,
    nodeType: input.nodeType,
    position: placement.position,
    placementPoint: input.placementPoint,
    parentId: input.parentId,
  });

  return {
    node: {
      id: nodeId,
      nodeType: input.nodeType,
      data: input.data as never,
      ...(resolved.position ? { position: resolved.position } : {}),
      ...(placement.size ? { size: placement.size } : {}),
      ...(resolved.parentId ? { parentId: resolved.parentId } : {}),
      ...(input.skipAutoLayout ? { skipAutoLayout: true } : {}),
    },
    traceNode: {
      id: nodeId,
      nodeType: input.nodeType,
      label: input.data?.label as string | undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Resolver entry point
// ---------------------------------------------------------------------------

/**
 * Resolve a web-only UI intent into commands + trace.
 *
 * The returned resolution contains one or more explicit CanvasCommands
 * and the trace entries that describe the user action for the LLM.
 */
export function resolveUiIntent(
  intent: CanvasUiIntent,
  ui: UiResolverState,
): UiIntentResolution {
  switch (intent.type) {
    case 'GROUP_SELECTION_INTO_FRAME':
      return resolveGroupSelectionIntoFrame(intent, ui);
    case 'GROUP_RECT_INTO_FRAME':
      return resolveGroupRectIntoFrame(intent, ui);
    case 'PASTE_CLIPBOARD':
      return resolvePasteClipboard(intent, ui);
    case 'NODE_DRAG_STOP':
      return resolveNodeDragStop(intent, ui);
    case 'SELECT_NODES':
      return resolveSelectNodes(intent, ui);
    case 'ALIGN_SELECTED_NODES':
      return resolveAlignSelected(intent, ui);
    case 'DISTRIBUTE_SELECTED_NODES':
      return resolveDistributeSelected(intent, ui);
    case 'REORDER_SELECTED_NODES':
      return resolveReorderSelected(intent, ui);
    case 'ADD_NODES':
      return resolveAddNodes(intent, ui);
    case 'DELETE_NODES':
      return resolveDeleteNodes(intent, ui);
    case 'UPDATE_NODE_DATA':
      return resolveUpdateNodeData(intent, ui);
    case 'CONNECT_EDGE':
      return resolveConnectEdge(intent, ui);
    case 'DISCONNECT_EDGE':
      return resolveDisconnectEdge(intent, ui);
    case 'RESIZE_NODE':
      return resolveResizeNode(intent, ui);
    case 'REORDER_NODE':
      return resolveReorderNode(intent, ui);
    case 'DISSOLVE_FRAME':
      return resolveDissolveFrame(intent, ui);
    case 'TOGGLE_NODE_LOCK':
      return resolveToggleNodeLock(intent, ui);
    case 'LAYOUT_ALL':
      return resolveLayoutAll(intent);
    case 'LAYOUT_GROUP':
      return resolveLayoutGroup(intent);
    case 'MOVE_NODE_INTO_FRAME':
      return resolveMoveNodeIntoFrame(intent, ui);
    case 'MOVE_NODE_OUT_OF_FRAME':
      return resolveMoveNodeOutOfFrame(intent, ui);
    case 'EXPAND_NODE':
      return resolveExpandNode(intent, ui);
  }
}

// ---------------------------------------------------------------------------
// PASTE_CLIPBOARD
// ---------------------------------------------------------------------------
// TODO: double-check
function resolvePasteClipboard(
  intent: Extract<CanvasUiIntent, { type: 'PASTE_CLIPBOARD' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const { clipboard, nodes } = ui;
  if (clipboard.length === 0) {
    return { commands: [], trace: [] };
  }

  const rootNodes = clipboard.filter((node) => !node.parentId);
  const anchorNode = rootNodes[0] ?? clipboard[0];
  const offsetX = intent.flowPosition
    ? intent.flowPosition.x - anchorNode.position.x
    : DEFAULT_PASTE_OFFSET;
  const offsetY = intent.flowPosition
    ? intent.flowPosition.y - anchorNode.position.y
    : DEFAULT_PASTE_OFFSET;

  const idMap = new Map<string, CanvasNodeId>();
  for (const node of clipboard) {
    idMap.set(node.id, createId('node'));
  }

  const existingLabels = nodes.map(
    (node) => node.data?.label as string | undefined,
  );
  const created: Extract<CanvasCommand, { type: 'CREATE_NODES' }>['nodes'] = [];
  const traceNodes: Array<{
    id: CanvasNodeId;
    nodeType: CanvasNodeType;
    label?: string;
  }> = [];

  for (const node of clipboard) {
    const nodeId = idMap.get(node.id);
    if (!nodeId) continue;

    const originalLabel = String(node.data?.label ?? '').trim();
    const originalLabelSource = (
      node.data as Record<string, unknown> | undefined
    )?.labelSource as string | undefined;
    const isAutoLabel =
      !originalLabel || !originalLabelSource || originalLabelSource === 'auto';
    const nodeType = (node.type ?? 'note') as CanvasNodeType;
    const label = isAutoLabel
      ? generateNextLabel(node.type || 'node', existingLabels)
      : deduplicateLabel(originalLabel, existingLabels);
    existingLabels.push(label);

    const clonedData = JSON.parse(JSON.stringify(node.data ?? {}));
    delete clonedData.sourceId;
    clonedData.label = label;
    clonedData.origin = { type: 'user-pasted' };

    const hasRemappedParent = !!(node.parentId && idMap.has(node.parentId));
    const position = hasRemappedParent
      ? { x: node.position.x, y: node.position.y }
      : { x: node.position.x + offsetX, y: node.position.y + offsetY };
    const size = canvasSizeFromStyle(node.style);
    const parentId =
      hasRemappedParent && node.parentId
        ? (idMap.get(node.parentId) as CanvasNodeId | undefined)
        : undefined;

    created.push({
      id: nodeId,
      nodeType,
      data: clonedData,
      position,
      ...(size ? { size } : {}),
      ...(parentId ? { parentId } : {}),
      skipAutoLayout: true,
    });
    traceNodes.push({ id: nodeId, nodeType, label });
  }

  return {
    commands: [{ type: 'CREATE_NODES', nodes: created }],
    trace:
      traceNodes.length > 0
        ? [{ action: 'node_created', nodes: traceNodes }]
        : [],
  };
}

// ---------------------------------------------------------------------------
// GROUP_SELECTION_INTO_FRAME
// ---------------------------------------------------------------------------

function resolveGroupSelectionIntoFrame(
  _intent: Extract<CanvasUiIntent, { type: 'GROUP_SELECTION_INTO_FRAME' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const selectedIds = ui.nodes.filter((n) => n.selected).map((n) => n.id);
  const commands: CanvasCommand[] = [];

  if (selectedIds.length < 2) {
    return {
      commands,
      trace: [],
    };
  }

  // Use the frameNodes utility to compute the new frame + reparented nodes.
  const frameId = createId('node');
  const result = frameNodes(ui.nodes as NestableNode[], selectedIds, {
    frameId,
    label: 'Frame',
  });

  // The frameNodes utility returns a fully rewritten node array. We need to
  // express this as CREATE_NODES (for the frame) + SET_NODE_PARENT (for children)
  // + SET_NODE_SELECTION (select the frame).
  const frameNode = result.nodes.find((n) => n.id === frameId);
  if (frameNode) {
    commands.push({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: frameId as CanvasNodeId,
          nodeType: 'frame',
          data: { label: 'Frame' } as never,
          position: frameNode.position,
          size: {
            width: (frameNode.style as Record<string, number>)?.width ?? 400,
            height: (frameNode.style as Record<string, number>)?.height ?? 300,
          },
        },
      ],
    });
  }

  commands.push({
    type: 'SET_NODE_PARENT',
    nodeIds: selectedIds as CanvasNodeId[],
    parentId: frameId as CanvasNodeId,
  });

  commands.push({
    type: 'SET_NODE_SELECTION',
    nodeIds: [frameId as CanvasNodeId],
  });

  return {
    commands,
    trace: [
      {
        action: 'node_created' as const,
        nodes: [{ id: frameId, nodeType: 'frame' as const, label: 'Frame' }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// GROUP_RECT_INTO_FRAME
// ---------------------------------------------------------------------------

function resolveGroupRectIntoFrame(
  intent: Extract<CanvasUiIntent, { type: 'GROUP_RECT_INTO_FRAME' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const commands: CanvasCommand[] = [];
  const frameId = createId('node');
  const result = frameNodesInRect(
    ui.nodes as NestableNode[],
    intent.flowRect,
    frameId,
  );

  const frameNode = result.nodes.find((n) => n.id === frameId);
  if (frameNode) {
    commands.push({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: frameId as CanvasNodeId,
          nodeType: 'frame',
          data: { label: 'Frame' } as never,
          position: frameNode.position,
          size: {
            width:
              (frameNode.style as Record<string, number>)?.width ??
              intent.flowRect.width,
            height:
              (frameNode.style as Record<string, number>)?.height ??
              intent.flowRect.height,
          },
        },
      ],
    });
  }

  // Find nodes that were reparented into the new frame.
  const childIds = result.nodes
    .filter((n) => n.parentId === frameId && n.id !== frameId)
    .map((n) => n.id);

  if (childIds.length > 0) {
    commands.push({
      type: 'SET_NODE_PARENT',
      nodeIds: childIds as CanvasNodeId[],
      parentId: frameId as CanvasNodeId,
    });
  }

  commands.push({
    type: 'SET_NODE_SELECTION',
    nodeIds: [frameId as CanvasNodeId],
  });

  return {
    commands,
    trace: [
      {
        action: 'node_created' as const,
        nodes: [{ id: frameId, nodeType: 'frame' as const, label: 'Frame' }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// NODE_DRAG_STOP
// ---------------------------------------------------------------------------

function resolveNodeDragStop(
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
  const geometryUpdates: Array<{ nodeId: CanvasNodeId; position: Point }> = [];
  const parentChanges = new Map<string, string | null>(); // nodeId → new parentId

  for (const id of intent.draggedNodeIds) {
    const node = result.find((n) => n.id === id);
    if (!node) continue;

    const prevParentId = preParentIds.get(id);
    const nextParentId = node.parentId ?? null;

    if (prevParentId !== nextParentId) {
      parentChanges.set(id, nextParentId);
    }

    // Always emit geometry for dragged nodes (position may have changed
    // due to reparenting, even if the visual position is the same).
    if (prevParentId !== nextParentId) {
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
  if (affectedFrameIds.size > 0) {
    result = fitFrames(result, affectedFrameIds);
  }

  if (result === nodes && parentChanges.size === 0) {
    // No structural changes — just emit geometry for frame fitting if needed.
    if (affectedFrameIds.size > 0) {
      // Collect updated geometry from frame fitting.
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
            ...(size ? { size } : {}),
          } as never);
        }
      }
      if (geometryUpdates.length > 0) {
        commands.push({ type: 'SET_NODE_GEOMETRY', items: geometryUpdates });
      }
    }
    // Moved nodes trace.
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
  // Group by target parent.
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

  // Emit geometry updates for reparented nodes.
  if (geometryUpdates.length > 0) {
    commands.push({ type: 'SET_NODE_GEOMETRY', items: geometryUpdates });
  }

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

// ---------------------------------------------------------------------------
// SELECT_NODES
// ---------------------------------------------------------------------------

function resolveSelectNodes(
  intent: Extract<CanvasUiIntent, { type: 'SELECT_NODES' }>,
  ui: UiResolverState,
): UiIntentResolution {
  let finalSelection: string[];

  if (intent.mode === 'toggle') {
    const currentlySelected = new Set(
      ui.nodes.filter((n) => n.selected).map((n) => n.id),
    );
    for (const id of intent.nodeIds) {
      if (currentlySelected.has(id)) {
        currentlySelected.delete(id);
      } else {
        currentlySelected.add(id);
      }
    }
    finalSelection = Array.from(currentlySelected);
  } else {
    finalSelection = intent.nodeIds;
  }

  const selectedNodes = ui.nodes.filter((n) => finalSelection.includes(n.id));
  const trace: RecentAction[] = [];
  if (selectedNodes.length === 1) {
    trace.push({
      action: 'node_selected',
      node: extractNodeRef(selectedNodes[0]),
    });
  } else if (selectedNodes.length > 1) {
    trace.push({
      action: 'nodes_selected',
      nodes: selectedNodes.map(extractNodeRef),
    });
  }

  return {
    commands: [
      {
        type: 'SET_NODE_SELECTION',
        nodeIds: finalSelection as CanvasNodeId[],
      },
    ],
    trace,
  };
}

// ---------------------------------------------------------------------------
// ALIGN_SELECTED_NODES
// ---------------------------------------------------------------------------

function resolveAlignSelected(
  intent: Extract<CanvasUiIntent, { type: 'ALIGN_SELECTED_NODES' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const selectedIds = ui.nodes.filter((n) => n.selected).map((n) => n.id);

  return {
    commands: [
      {
        type: 'ALIGN_NODES',
        nodeIds: selectedIds as CanvasNodeId[],
        direction: intent.direction,
      },
    ],
    trace: [],
  };
}

// ---------------------------------------------------------------------------
// DISTRIBUTE_SELECTED_NODES
// ---------------------------------------------------------------------------

function resolveDistributeSelected(
  _intent: Extract<CanvasUiIntent, { type: 'DISTRIBUTE_SELECTED_NODES' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const selectedIds = ui.nodes.filter((n) => n.selected).map((n) => n.id);

  return {
    commands: [
      {
        type: 'DISTRIBUTE_NODES',
        nodeIds: selectedIds as CanvasNodeId[],
      },
    ],
    trace: [],
  };
}

// ---------------------------------------------------------------------------
// REORDER_SELECTED_NODES
// ---------------------------------------------------------------------------

function resolveReorderSelected(
  intent: Extract<CanvasUiIntent, { type: 'REORDER_SELECTED_NODES' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const selectedIds = ui.nodes.filter((n) => n.selected).map((n) => n.id);
  const selectedNodes = ui.nodes.filter((n) => selectedIds.includes(n.id));

  return {
    commands:
      selectedIds.length === 0
        ? []
        : [
            {
              type: 'REORDER_NODES',
              nodeIds: selectedIds as CanvasNodeId[],
              to: intent.to,
            },
          ],
    trace:
      selectedNodes.length > 0
        ? [
            {
              action: 'nodes_reordered',
              nodes: selectedNodes.map(extractNodeRef),
            },
          ]
        : [],
  };
}

// ---------------------------------------------------------------------------
// ADD_NODES
// ---------------------------------------------------------------------------

function resolveAddNodes(
  intent: Extract<CanvasUiIntent, { type: 'ADD_NODES' }>,
  ui: UiResolverState,
): UiIntentResolution {
  if (intent.inputs.length === 0) {
    return { commands: [], trace: [] };
  }

  const created = intent.inputs.map((input) => materializeAddNode(input, ui));

  return {
    commands: [
      {
        type: 'CREATE_NODES',
        nodes: created.map((item) => item.node),
      },
    ],
    trace: [
      {
        action: 'node_created',
        nodes: created.map((item) => item.traceNode),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// DELETE_NODES
// ---------------------------------------------------------------------------

function resolveDeleteNodes(
  intent: Extract<CanvasUiIntent, { type: 'DELETE_NODES' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const toDelete = ui.nodes.filter((n) => intent.nodeIds.includes(n.id));
  return {
    commands: [
      {
        type: 'DELETE_NODES',
        nodeIds: intent.nodeIds as CanvasNodeId[],
      },
    ],
    trace:
      toDelete.length > 0
        ? [
            {
              action: 'nodes_deleted',
              nodes: toDelete.map((n) => ({
                ...extractNodeRef(n),
                snippet: extractSnippet(n),
              })),
            },
          ]
        : [],
  };
}

// ---------------------------------------------------------------------------
// UPDATE_NODE_DATA
// ---------------------------------------------------------------------------

function resolveUpdateNodeData(
  intent: Extract<CanvasUiIntent, { type: 'UPDATE_NODE_DATA' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const node = ui.nodes.find((n) => n.id === intent.nodeId);
  return {
    commands: [
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          { nodeId: intent.nodeId as CanvasNodeId, patch: intent.patch },
        ],
      },
    ],
    trace: node ? [{ action: 'node_edited', node: extractNodeRef(node) }] : [],
  };
}

// ---------------------------------------------------------------------------
// CONNECT_EDGE
// ---------------------------------------------------------------------------

function resolveConnectEdge(
  intent: Extract<CanvasUiIntent, { type: 'CONNECT_EDGE' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const sourceNode = ui.nodes.find((n) => n.id === intent.source);
  const targetNode = ui.nodes.find((n) => n.id === intent.target);
  return {
    commands: [
      {
        type: 'CONNECT_NODES',
        edges: [
          {
            source: intent.source as CanvasNodeId,
            target: intent.target as CanvasNodeId,
          },
        ],
      },
    ],
    trace:
      sourceNode && targetNode
        ? [
            {
              action: 'node_connected',
              source: extractNodeRef(sourceNode),
              target: extractNodeRef(targetNode),
            },
          ]
        : [],
  };
}

// ---------------------------------------------------------------------------
// DISCONNECT_EDGE
// ---------------------------------------------------------------------------

function resolveDisconnectEdge(
  intent: Extract<CanvasUiIntent, { type: 'DISCONNECT_EDGE' }>,
  ui: UiResolverState,
): UiIntentResolution {
  // Build trace from the edge data before removal.
  const edgesToRemove = ui.edges.filter((e) => intent.edgeIds.includes(e.id));
  const disconnectedPairs = edgesToRemove
    .map((e) => {
      const source = ui.nodes.find((n) => n.id === e.source);
      const target = ui.nodes.find((n) => n.id === e.target);
      if (source && target) {
        return {
          source: extractNodeRef(source),
          target: extractNodeRef(target),
        };
      }
      return null;
    })
    .filter((p): p is NonNullable<typeof p> => !!p);

  return {
    commands: [
      {
        type: 'DISCONNECT_EDGES',
        edges: intent.edgeIds as CanvasEdgeId[],
      },
    ],
    trace:
      disconnectedPairs.length > 0
        ? [{ action: 'edges_disconnected', edges: disconnectedPairs }]
        : [],
  };
}

// ---------------------------------------------------------------------------
// RESIZE_NODE
// ---------------------------------------------------------------------------

function resolveResizeNode(
  intent: Extract<CanvasUiIntent, { type: 'RESIZE_NODE' }>,
  ui: UiResolverState,
): UiIntentResolution {
  // One trace entry per intent �?use the first item with a size.
  const trace: RecentAction[] = [];
  const primary = intent.items.find((i) => i.size);
  if (primary?.size) {
    const node = ui.nodes.find((n) => n.id === primary.nodeId);
    if (node) {
      trace.push({
        action: 'node_resized',
        node: extractNodeRef(node),
        width: primary.size.width,
        height: primary.size.height,
      });
    }
  }
  return {
    commands: [
      {
        type: 'SET_NODE_GEOMETRY',
        items: intent.items.map((item) => ({
          nodeId: item.nodeId as CanvasNodeId,
          ...(item.size ? { size: item.size } : {}),
          ...(item.position ? { position: item.position } : {}),
        })),
      },
    ],
    trace,
  };
}

// ---------------------------------------------------------------------------
// REORDER_NODE
// ---------------------------------------------------------------------------

function resolveReorderNode(
  intent: Extract<CanvasUiIntent, { type: 'REORDER_NODE' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const node = ui.nodes.find((n) => n.id === intent.activeId);
  return {
    commands: [
      {
        type: 'REORDER_NODES',
        nodeIds: [intent.activeId as CanvasNodeId],
        to: { before: intent.overId as CanvasNodeId },
      },
    ],
    trace: node
      ? [{ action: 'nodes_reordered', nodes: [extractNodeRef(node)] }]
      : [],
  };
}

// ---------------------------------------------------------------------------
// DISSOLVE_FRAME
// ---------------------------------------------------------------------------

function resolveDissolveFrame(
  intent: Extract<CanvasUiIntent, { type: 'DISSOLVE_FRAME' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const frame = ui.nodes.find((n) => n.id === intent.frameId);
  const children = ui.nodes.filter((n) => n.parentId === intent.frameId);
  return {
    commands: [
      {
        type: 'DISSOLVE_FRAME',
        frameId: intent.frameId as CanvasNodeId,
      },
    ],
    trace: frame
      ? [
          {
            action: 'frame_unframed',
            frame: extractNodeRef(frame),
            nodes: children.map(extractNodeRef),
          },
        ]
      : [],
  };
}

// ---------------------------------------------------------------------------
// TOGGLE_NODE_LOCK
// ---------------------------------------------------------------------------

function resolveToggleNodeLock(
  intent: Extract<CanvasUiIntent, { type: 'TOGGLE_NODE_LOCK' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const node = ui.nodes.find((n) => n.id === intent.nodeId);
  if (!node) {
    return { commands: [], trace: [] };
  }
  return {
    commands: [
      {
        type: 'SET_NODE_LOCKED',
        items: [
          { nodeId: intent.nodeId as CanvasNodeId, locked: !node.data?.locked },
        ],
      },
    ],
    trace: [],
  };
}

// ---------------------------------------------------------------------------
// LAYOUT_ALL
// ---------------------------------------------------------------------------

function resolveLayoutAll(
  _intent: Extract<CanvasUiIntent, { type: 'LAYOUT_ALL' }>,
): UiIntentResolution {
  return {
    commands: [{ type: 'AUTO_LAYOUT', scope: { type: 'canvas' } }],
    trace: [],
  };
}

// ---------------------------------------------------------------------------
// LAYOUT_GROUP
// ---------------------------------------------------------------------------

function resolveLayoutGroup(
  intent: Extract<CanvasUiIntent, { type: 'LAYOUT_GROUP' }>,
): UiIntentResolution {
  return {
    commands: [
      {
        type: 'AUTO_LAYOUT',
        scope: { type: 'frame', frameId: intent.frameId as CanvasNodeId },
      },
    ],
    trace: [],
  };
}

// ---------------------------------------------------------------------------
// MOVE_NODE_INTO_FRAME
// ---------------------------------------------------------------------------
function resolveMoveNodeIntoFrame(
  intent: Extract<CanvasUiIntent, { type: 'MOVE_NODE_INTO_FRAME' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const node = ui.nodes.find((n) => n.id === intent.nodeId);
  const frame = ui.nodes.find((n) => n.id === intent.frameId);
  return {
    commands: [
      {
        type: 'SET_NODE_PARENT',
        nodeIds: [intent.nodeId as CanvasNodeId],
        parentId: intent.frameId as CanvasNodeId,
      },
    ],
    trace:
      node && frame
        ? [
            {
              action: 'node_framed',
              node: extractNodeRef(node),
              frame: extractNodeRef(frame),
            },
          ]
        : [],
  };
}

// ---------------------------------------------------------------------------
// MOVE_NODE_OUT_OF_FRAME
// ---------------------------------------------------------------------------
function resolveMoveNodeOutOfFrame(
  intent: Extract<CanvasUiIntent, { type: 'MOVE_NODE_OUT_OF_FRAME' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const node = ui.nodes.find((n) => n.id === intent.nodeId);
  const frame = node?.parentId
    ? ui.nodes.find((n) => n.id === node.parentId)
    : undefined;
  return {
    commands: [
      {
        type: 'SET_NODE_PARENT',
        nodeIds: [intent.nodeId as CanvasNodeId],
        parentId: null,
      },
    ],
    trace:
      node && frame
        ? [
            {
              action: 'node_unframed',
              node: extractNodeRef(node),
              frame: extractNodeRef(frame),
            },
          ]
        : [],
  };
}

// ---------------------------------------------------------------------------
// EXPAND_NODE
// ---------------------------------------------------------------------------
function resolveExpandNode(
  intent: Extract<CanvasUiIntent, { type: 'EXPAND_NODE' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const node = ui.nodes.find((n) => n.id === intent.nodeId);
  return {
    commands: [
      {
        type: 'SET_EXPANDED_NODE',
        nodeId: intent.nodeId as CanvasNodeId,
      },
    ],
    trace: node
      ? [{ action: 'node_expanded', node: extractNodeRef(node) }]
      : [],
  };
}
