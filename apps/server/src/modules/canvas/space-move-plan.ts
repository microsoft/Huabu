// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  CANVAS_NODE_TYPES,
  createId,
  type CanvasCommand,
  type CanvasEdgeId,
  type CanvasNodeId,
  type CanvasNodeType,
  type EdgeStyle,
} from '@huabu/shared';
import {
  deduplicateLabel,
  getAbsolutePosition,
  getNodeDefaultSize,
  type CanvasEdge,
  type CanvasNode,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

const DESTINATION_GAP = 160;
const PREVIEW_MIN_WIDTH = 480;
const PREVIEW_MIN_HEIGHT = 320;
const PREVIEW_MAX_WIDTH = 2400;
const PREVIEW_MAX_HEIGHT = 1600;
const MOVABLE_TYPES = new Set<CanvasNodeType>(
  CANVAS_NODE_TYPES.filter(
    (type) =>
      type !== 'spacePreview' &&
      type !== 'canvasRef' &&
      type !== 'frameRef' &&
      type !== 'nodeRef',
  ),
);

export class SpaceMovePlanError extends Error {
  constructor(
    readonly code: 'missing-node' | 'not-movable' | 'invalid-hierarchy',
    readonly nodeId: string,
  ) {
    super(`Cannot move node ${nodeId}: ${code}`);
    this.name = 'SpaceMovePlanError';
  }
}

export interface SpaceMovePlan {
  commands: CanvasCommand[];
  sourceCommands: CanvasCommand[];
  sourcePreviewNodeId: CanvasNodeId;
  rootIds: string[];
  movedIds: Set<string>;
  nodeIdMap: Map<string, CanvasNodeId>;
  movedFrameCount: number;
  movedThreadIds: string[];
  omittedBoundaryEdges: Array<{
    edgeId: string;
    source: string;
    target: string;
  }>;
  renamedNodes: Array<{ sourceNodeId: string; from: string; to: string }>;
}

function nodeSize(node: CanvasNode): { width: number; height?: number } | null {
  const width = node.style?.width;
  const height = node.style?.height;
  if (typeof width !== 'number') return null;
  return {
    width,
    ...(typeof height === 'number' ? { height } : {}),
  };
}

function occupiedSize(node: CanvasNode): { width: number; height: number } {
  const defaults = getNodeDefaultSize(node.type ?? 'note');
  return {
    width:
      typeof node.style?.width === 'number' ? node.style.width : defaults.width,
    height:
      typeof node.style?.height === 'number'
        ? node.style.height
        : (defaults.height ?? 100),
  };
}

function assertAcyclic(nodes: readonly CanvasNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const visited = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId) {
      if (visited.has(parentId)) {
        throw new SpaceMovePlanError('invalid-hierarchy', node.id);
      }
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
  }
}

function normalizedRoots(
  selectedNodeIds: readonly string[],
  byId: ReadonlyMap<string, CanvasNode>,
): string[] {
  const selected = new Set(selectedNodeIds);
  return [...selected].filter((nodeId) => {
    let parentId = byId.get(nodeId)?.parentId;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent) break;
      if (selected.has(parentId) && parent.type === 'frame') return false;
      parentId = parent.parentId;
    }
    return true;
  });
}

function expandedMoveIds(
  rootIds: readonly string[],
  nodes: readonly CanvasNode[],
): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const values = children.get(node.parentId) ?? [];
    values.push(node.id);
    children.set(node.parentId, values);
  }

  const moved = new Set(rootIds);
  const stack = rootIds.filter(
    (nodeId) => nodes.find((node) => node.id === nodeId)?.type === 'frame',
  );
  while (stack.length > 0) {
    const parentId = stack.pop();
    if (!parentId) continue;
    for (const childId of children.get(parentId) ?? []) {
      if (moved.has(childId)) continue;
      moved.add(childId);
      if (nodes.find((node) => node.id === childId)?.type === 'frame') {
        stack.push(childId);
      }
    }
  }
  return moved;
}

export function buildSpaceMovePlan(input: {
  sourceNodes: readonly CanvasNode[];
  sourceEdges: readonly CanvasEdge[];
  destinationNodes: readonly CanvasNode[];
  selectedNodeIds: readonly string[];
  destinationCanvasId: string;
}): SpaceMovePlan {
  const {
    sourceNodes,
    sourceEdges,
    destinationNodes,
    selectedNodeIds,
    destinationCanvasId,
  } = input;
  assertAcyclic(sourceNodes);
  const byId = new Map(sourceNodes.map((node) => [node.id, node]));
  for (const nodeId of new Set(selectedNodeIds)) {
    const node = byId.get(nodeId);
    if (!node) throw new SpaceMovePlanError('missing-node', nodeId);
    if (!MOVABLE_TYPES.has(node.type as CanvasNodeType)) {
      throw new SpaceMovePlanError('not-movable', nodeId);
    }
  }

  const rootIds = normalizedRoots(selectedNodeIds, byId);
  const movedIds = expandedMoveIds(rootIds, sourceNodes);
  for (const nodeId of movedIds) {
    const node = byId.get(nodeId);
    if (!node || !MOVABLE_TYPES.has(node.type as CanvasNodeType)) {
      throw new SpaceMovePlanError('not-movable', nodeId);
    }
  }

  const nodeIdMap = new Map<string, CanvasNodeId>();
  for (const nodeId of movedIds) nodeIdMap.set(nodeId, createId('node'));

  const destinationRight = destinationNodes.reduce((right, node) => {
    const position = getAbsolutePosition(
      destinationNodes as NestableNode[],
      node.id,
    );
    const width = typeof node.style?.width === 'number' ? node.style.width : 0;
    return position ? Math.max(right, position.x + width) : right;
  }, -DESTINATION_GAP);
  const rootPositions = rootIds.map((nodeId) => {
    const position = getAbsolutePosition(sourceNodes as NestableNode[], nodeId);
    if (!position) {
      throw new SpaceMovePlanError('invalid-hierarchy', nodeId);
    }
    return position;
  });
  const sourceLeft = Math.min(...rootPositions.map((position) => position.x));
  const sourceTop = Math.min(...rootPositions.map((position) => position.y));
  const offset = {
    x: destinationRight + DESTINATION_GAP - sourceLeft,
    y: -sourceTop,
  };

  const labels = destinationNodes.map((node) =>
    typeof node.data?.label === 'string' ? node.data.label : undefined,
  );
  const renamedNodes: SpaceMovePlan['renamedNodes'] = [];
  const creates: Extract<CanvasCommand, { type: 'CREATE_NODES' }>['nodes'] = [];
  const movedThreadIds: string[] = [];

  for (const node of sourceNodes) {
    if (!movedIds.has(node.id)) continue;
    const nodeId = nodeIdMap.get(node.id);
    if (!nodeId) continue;
    const nodeType = node.type as CanvasNodeType;
    const data = structuredClone(node.data ?? {});
    const originalLabel =
      typeof data.label === 'string' ? data.label.trim() : '';
    const label = deduplicateLabel(originalLabel || nodeType, labels);
    labels.push(label);
    data.label = label;
    if (label !== originalLabel) {
      renamedNodes.push({
        sourceNodeId: node.id,
        from: originalLabel,
        to: label,
      });
    }
    if (nodeType === 'sketch' && Array.isArray(data.strokes)) {
      data.strokes = data.strokes.map((stroke: Record<string, unknown>) => ({
        ...stroke,
        id: createId('stroke'),
      }));
    }
    if (
      nodeType === 'question' &&
      typeof data.threadId === 'string' &&
      data.threadId
    ) {
      movedThreadIds.push(data.threadId);
    }

    const remappedParent =
      node.parentId && movedIds.has(node.parentId)
        ? nodeIdMap.get(node.parentId)
        : undefined;
    const absolute = remappedParent
      ? node.position
      : getAbsolutePosition(sourceNodes as NestableNode[], node.id);
    if (!absolute) {
      throw new SpaceMovePlanError('invalid-hierarchy', node.id);
    }
    creates.push({
      id: nodeId,
      nodeType,
      data,
      position: remappedParent
        ? { ...absolute }
        : { x: absolute.x + offset.x, y: absolute.y + offset.y },
      ...(nodeSize(node) ? { size: nodeSize(node) ?? undefined } : {}),
      ...(remappedParent ? { parentId: remappedParent } : {}),
    });
  }

  const edges: Extract<CanvasCommand, { type: 'CONNECT_NODES' }>['edges'] = [];
  const omittedBoundaryEdges: SpaceMovePlan['omittedBoundaryEdges'] = [];
  for (const edge of sourceEdges) {
    const sourceMoved = movedIds.has(edge.source);
    const targetMoved = movedIds.has(edge.target);
    if (sourceMoved && targetMoved) {
      const source = nodeIdMap.get(edge.source);
      const target = nodeIdMap.get(edge.target);
      if (!source || !target) continue;
      const style = (edge.data as { edgeStyle?: EdgeStyle } | undefined)
        ?.edgeStyle;
      edges.push({
        id: createId('edge') as CanvasEdgeId,
        source,
        target,
        ...(style ? { style: structuredClone(style) } : {}),
      });
    } else if (sourceMoved !== targetMoved) {
      omittedBoundaryEdges.push({
        edgeId: edge.id,
        source: edge.source,
        target: edge.target,
      });
    }
  }

  const commands: CanvasCommand[] = [{ type: 'CREATE_NODES', nodes: creates }];
  if (edges.length > 0) commands.push({ type: 'CONNECT_NODES', edges });

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const nodeId of movedIds) {
    const node = byId.get(nodeId);
    const position = getAbsolutePosition(sourceNodes as NestableNode[], nodeId);
    if (!node || !position) {
      throw new SpaceMovePlanError('invalid-hierarchy', nodeId);
    }
    const size = occupiedSize(node);
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + size.width);
    maxY = Math.max(maxY, position.y + size.height);
  }
  const sourcePreviewNodeId = createId('node');

  return {
    commands,
    sourceCommands: [
      {
        type: 'DELETE_NODES',
        nodeIds: rootIds.map((nodeId) => nodeId as CanvasNodeId),
      },
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: sourcePreviewNodeId,
            nodeType: 'spacePreview',
            data: { targetCanvasId: destinationCanvasId },
            position: { x: minX, y: minY },
            size: {
              width: Math.min(
                PREVIEW_MAX_WIDTH,
                Math.max(PREVIEW_MIN_WIDTH, maxX - minX),
              ),
              height: Math.min(
                PREVIEW_MAX_HEIGHT,
                Math.max(PREVIEW_MIN_HEIGHT, maxY - minY),
              ),
            },
            selectOnCreate: false,
          },
        ],
      },
    ],
    sourcePreviewNodeId,
    rootIds,
    movedIds,
    nodeIdMap,
    movedFrameCount: [...movedIds].filter(
      (nodeId) => byId.get(nodeId)?.type === 'frame',
    ).length,
    movedThreadIds: [...new Set(movedThreadIds)].sort(),
    omittedBoundaryEdges,
    renamedNodes,
  };
}
