import {
  createId,
  type CanvasCommand,
  type CanvasNodeId,
  type CanvasNodeType,
  type Point,
} from '@sediment/shared';

import { deduplicateLabel, generateNextLabel } from '@/utils/node/labels';

import { canvasSizeFromStyle, resolveFrameAtPoint } from '../utils';
import { type NestableNode } from '../utils/frame';

import type {
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';

const DEFAULT_PASTE_OFFSET = 40;

export default function resolvePasteClipboard(
  intent: Extract<CanvasUiIntent, { type: 'PASTE_CLIPBOARD' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const { clipboard, nodes } = ui;
  if (clipboard.length === 0) {
    return { commands: [], trace: [] };
  }

  // Build id remapping for all clipboard nodes.
  const idMap = new Map<string, CanvasNodeId>();
  for (const node of clipboard) {
    idMap.set(node.id, createId('node'));
  }

  // Compute the uniform offset for root nodes.
  // Center the anchor node at flowPosition (like addNode centers at placementPoint).
  const rootNodes = clipboard.filter((node) => !node.parentId);
  const anchorNode = rootNodes[0] ?? clipboard[0];
  const anchorSize = canvasSizeFromStyle(anchorNode.style);
  const anchorW = anchorSize?.width ?? 0;
  const anchorH =
    typeof anchorSize?.height === 'number' ? anchorSize.height : 0;
  const offsetX = intent.flowPosition
    ? intent.flowPosition.x - anchorNode.position.x - anchorW / 2
    : DEFAULT_PASTE_OFFSET;
  const offsetY = intent.flowPosition
    ? intent.flowPosition.y - anchorNode.position.y - anchorH / 2
    : DEFAULT_PASTE_OFFSET;

  // Frame hit-test once at flowPosition — all root nodes go into the
  // same frame (or none).
  let pasteParentId: CanvasNodeId | undefined;
  let frameOffset: Point | undefined;
  if (intent.flowPosition) {
    const hit = resolveFrameAtPoint(
      nodes as NestableNode[],
      intent.flowPosition,
    );
    if (hit) {
      pasteParentId = hit.parentId as CanvasNodeId;
      frameOffset = hit.absolutePosition;
    }
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

    // Resolve label.
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

    // Clone data.
    const clonedData = JSON.parse(JSON.stringify(node.data ?? {}));
    delete clonedData.sourceId;
    clonedData.label = label;
    clonedData.origin = { type: 'user-pasted' };

    const hasRemappedParent = !!(node.parentId && idMap.has(node.parentId));

    let position: Point;
    let parentId: CanvasNodeId | undefined;

    if (hasRemappedParent) {
      // Children keep their position relative to their (remapped) parent.
      position = { x: node.position.x, y: node.position.y };
      parentId = node.parentId
        ? (idMap.get(node.parentId) as CanvasNodeId | undefined)
        : undefined;
    } else {
      // Root nodes: apply uniform offset, then adjust for frame if needed.
      position = {
        x: node.position.x + offsetX,
        y: node.position.y + offsetY,
      };
      if (pasteParentId && frameOffset) {
        parentId = pasteParentId;
        position = {
          x: position.x - frameOffset.x,
          y: position.y - frameOffset.y,
        };
      }
    }

    const size = canvasSizeFromStyle(node.style);

    created.push({
      id: nodeId,
      nodeType,
      data: clonedData,
      position,
      ...(size && { size }),
      ...(parentId && { parentId }),
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
