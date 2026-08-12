// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
} from '@huabu/shared';
import { getNodeDefaultSize } from '@huabu/shared/canvas-engine';

import { resolveFrameAtPoint } from '../utils';

import type {
  AddNodeInput,
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';
import type { NestableNode } from '@huabu/shared/canvas-engine';

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
// Viewport-centre fallback
// ---------------------------------------------------------------------------
/**
 * Per-node stagger applied when several nodes in the same batch fall
 * back to viewport-centre placement. Matches the constant used by
 * `resolvePasteClipboard` so the visual behaviour is consistent across
 * "paste with no anchor" and "add with no anchor" flows.
 */
const VIEWPORT_FALLBACK_STAGGER = 40;
const NOTE_DEFAULT_HEIGHT = getNodeDefaultSize('note').height;
const VIEWPORT_FALLBACK_HEIGHT =
  typeof NOTE_DEFAULT_HEIGHT === 'number' ? NOTE_DEFAULT_HEIGHT : 100;

/**
 * Anchor a new node so its bounding box is centred on the given flow
 * point, with a uniform per-index stagger so multiple nodes added in
 * the same batch don't perfectly overlap.
 *
 * Some content-driven node types may not provide an explicit default
 * height. In that case we use a shared viewport fallback height so
 * centring still feels balanced until measured dimensions are available.
 */
function viewportCenterAnchor(
  nodeType: CanvasNodeType,
  size: NodeSize | undefined,
  center: Point,
  staggerIndex: number,
): Point {
  const defaults = getNodeDefaultSize(nodeType);
  const width = size?.width ?? defaults.width;
  const height =
    (typeof size?.height === 'number' ? size.height : undefined) ??
    (typeof defaults.height === 'number' ? defaults.height : undefined) ??
    VIEWPORT_FALLBACK_HEIGHT;
  const offset = staggerIndex * VIEWPORT_FALLBACK_STAGGER;
  return {
    x: center.x - width / 2 + offset,
    y: center.y - height / 2 + offset,
  };
}

// ---------------------------------------------------------------------------
// Node materialization
// ---------------------------------------------------------------------------
function materializeAddNode(
  input: AddNodeInput,
  ui: UiResolverState,
  fallbackStaggerIndex: number,
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

  // Fallback: no explicit anchor was given (e.g. "Add as note" button in
  // a chat panel). Centre the node in the current viewport so it lands
  // in the visible area. The shared engine no longer ships a layout
  // fallback, so the resolver must always commit to a position — when
  // `viewportCenter` is also missing (initial boot before React Flow
  // registers) we default to `(0, 0)` rather than letting the engine
  // see an undefined slot.
  if (!position) {
    position = ui.viewportCenter
      ? viewportCenterAnchor(
          input.nodeType,
          size,
          ui.viewportCenter,
          fallbackStaggerIndex,
        )
      : { x: 0, y: 0 };
  }

  return {
    node: {
      id: nodeId,
      nodeType: input.nodeType,
      data: input.data as never,
      position,
      ...(size && { size }),
      ...(parentId && { parentId }),
      ...(input.selectOnCreate !== undefined && {
        selectOnCreate: input.selectOnCreate,
      }),
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
  const creatableInputs = intent.inputs.filter(
    (input) =>
      input.nodeType !== 'canvasRef' &&
      input.nodeType !== 'frameRef' &&
      input.nodeType !== 'nodeRef',
  );
  if (creatableInputs.length === 0) {
    return { commands: [], trace: [] };
  }

  // Only nodes that actually fall back to viewport-centre placement
  // (i.e. have no `placementPoint`) consume a stagger slot, so a mixed
  // batch — one drag-dropped input plus one button-click input — still
  // stagger correctly without leaving a gap.
  let staggerIndex = 0;
  const created = creatableInputs.map((input) => {
    const usesFallback = !input.placementPoint;
    const item = materializeAddNode(input, ui, staggerIndex);
    if (usesFallback) staggerIndex += 1;
    return item;
  });
  const onlyInput = creatableInputs.length === 1 ? creatableInputs[0] : null;
  const origin = onlyInput?.data?.origin as { type?: unknown } | undefined;
  const requestsEditing = origin?.type === 'user-created';

  return {
    commands: [
      {
        type: 'CREATE_NODES',
        nodes: created.map((item) => item.node),
      },
    ],
    ...(created.length === 1 &&
    requestsEditing &&
    (created[0].traceNode.type === 'note' ||
      created[0].traceNode.type === 'text')
      ? { editNodeId: created[0].traceNode.id }
      : {}),
    trace: [
      {
        action: 'node_created',
        nodes: created.map((item) => item.traceNode),
      },
    ],
  };
}
