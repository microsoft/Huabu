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
} from '@sediment/shared';

import { getNodeDefaultSize } from '@/config/nodeSizes';

import { resolveFrameAtPoint } from '../utils';

import type {
  AddNodeInput,
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';
import type { NestableNode } from '../utils/frame';

// ---------------------------------------------------------------------------
// Sizing helpers
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

// ---------------------------------------------------------------------------
// Node materialization
// ---------------------------------------------------------------------------
function materializeAddNode(
  input: AddNodeInput,
  ui: UiResolverState,
): {
  node: Extract<CanvasCommand, { type: 'CREATE_NODES' }>['nodes'][number];
  traceNode: {
    id: CanvasNodeId;
    type: CanvasNodeType;
    label?: string;
  };
} {
  const nodeId = input.id ?? createId('node');

  const size =
    input.size ??
    (input.naturalDimensions &&
      computeMediaSize(
        input.nodeType,
        input.naturalDimensions.width,
        input.naturalDimensions.height,
      ));

  // Anchor the new node with its top-left corner at the cursor position.
  let position = input.placementPoint
    ? { x: input.placementPoint.x, y: input.placementPoint.y }
    : undefined;

  let parentId = input.parentId;

  // Auto-nest into a frame when dropping onto one
  if (
    position &&
    input.placementPoint &&
    !parentId &&
    input.nodeType !== 'frame'
  ) {
    const hit = resolveFrameAtPoint(
      ui.nodes as NestableNode[],
      input.placementPoint,
    );
    if (hit) {
      parentId = hit.parentId as CanvasNodeId;
      position = {
        x: position.x - hit.absolutePosition.x,
        y: position.y - hit.absolutePosition.y,
      };
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
      type: input.nodeType,
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
