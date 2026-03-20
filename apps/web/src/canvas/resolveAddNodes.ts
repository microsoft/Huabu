/**
 * Resolver for the ADD_NODES UI intent.
 *
 * Extracted from uiIntent.ts to keep the main resolver file manageable.
 */

import {
  createId,
  type CanvasCommand,
  type CanvasNodeId,
  type CanvasNodeType,
  type NodeSize,
  type Point,
} from '@sediment/shared';

import {
  findFrameAtPoint,
  getAbsolutePosition,
  type NestableNode,
} from './utils/frame';
import { getNodeDefaultSize } from '../utils/node/nodeDefaultSize';

import type {
  AddNodeInput,
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from './uiIntent';

// ---------------------------------------------------------------------------
// Sizing & placement helpers
// ---------------------------------------------------------------------------
function computeMediaSize(
  nodeType: CanvasNodeType,
  naturalWidth: number,
  naturalHeight: number,
): NodeSize {
  const defaultSize = getNodeDefaultSize(nodeType);
  const targetWidth = defaultSize.width;

  if (naturalWidth <= 0 || naturalHeight <= 0) return defaultSize;

  return {
    width: targetWidth,
    height: Math.round(targetWidth * (naturalHeight / naturalWidth)),
  };
}

const AUTO_HEIGHT_Y_OFFSET = 20;
function nodePositionFromPlacementPoint(
  point: Point,
  nodeType: string,
  size?: NodeSize | null,
): Point {
  const resolvedSize = size ?? getNodeDefaultSize(nodeType);

  if (typeof resolvedSize.height !== 'number') {
    return {
      x: point.x - resolvedSize.width / 2,
      y: point.y - AUTO_HEIGHT_Y_OFFSET,
    };
  }

  return {
    x: point.x - resolvedSize.width / 2,
    y: point.y - resolvedSize.height / 2,
  };
}

// ---------------------------------------------------------------------------
// Frame placement helpers
// ---------------------------------------------------------------------------
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

  /*
   * Handle size and position resolution
   */
  const size =
    input.size ??
    (input.naturalDimensions &&
      computeMediaSize(
        input.nodeType,
        input.naturalDimensions.width,
        input.naturalDimensions.height,
      ));

  let position = input.placementPoint
    ? nodePositionFromPlacementPoint(input.placementPoint, input.nodeType, size)
    : undefined;

  let parentId = input.parentId;

  // Auto-nest into a frame when dropping onto one
  if (
    position &&
    input.placementPoint &&
    !parentId &&
    input.nodeType !== 'frame'
  ) {
    const frameId = findFrameAtPoint(
      ui.nodes as NestableNode[],
      input.placementPoint,
    );
    if (frameId) {
      const frameAbs = getAbsolutePosition(ui.nodes as NestableNode[], frameId);
      if (frameAbs) {
        parentId = frameId as CanvasNodeId;
        position = {
          x: position.x - frameAbs.x,
          y: position.y - frameAbs.y,
        };
      }
    }
  }

  return {
    node: {
      id: nodeId,
      nodeType: input.nodeType,
      data: input.data as never,
      ...(position && { position }),
      ...(size && { size }),
      ...(parentId && { parentId }),
      ...(input.skipAutoLayout && { skipAutoLayout: true }),
    },
    traceNode: {
      id: nodeId,
      nodeType: input.nodeType,
      label: input.data?.label as string | undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// ADD_NODES resolver
// ---------------------------------------------------------------------------
export default function resolveAddNodes(
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
