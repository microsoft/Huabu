// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createId,
  type CanvasCommand,
  type CanvasEdgeId,
  type CanvasNodeId,
  type CanvasNodeType,
  type EdgeStyle,
  type Point,
} from '@huabu/shared';
import {
  deduplicateLabel,
  generateNextLabel,
} from '@huabu/shared/canvas-engine';

import { canvasSizeFromStyle, resolveFrameAtPoint } from '../utils';

import type {
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';
import type { NestableNode } from '@huabu/shared/canvas-engine';

const DEFAULT_PASTE_OFFSET = 40;

export default function resolvePasteClipboard(
  intent: Extract<CanvasUiIntent, { type: 'PASTE_CLIPBOARD' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const { nodes } = ui;
  const clipboard = intent.clipboardNodes?.filter(
    (node) =>
      node.type !== 'canvasRef' &&
      node.type !== 'frameRef' &&
      node.type !== 'nodeRef',
  );
  if (!clipboard || clipboard.length === 0) {
    return { commands: [], trace: [] };
  }

  // Build id remapping for all clipboard nodes.
  const idMap = new Map<string, CanvasNodeId>();
  for (const node of clipboard) {
    idMap.set(node.id, createId('node'));
  }

  // Compute the uniform offset for root nodes.
  // Anchor the chosen root node's top-left corner at flowPosition
  // (matches addNode placement semantics).
  const rootNodes = clipboard.filter((node) => !node.parentId);
  const anchorNode = rootNodes[0] ?? clipboard[0];
  const offsetX = intent.flowPosition
    ? intent.flowPosition.x - anchorNode.position.x
    : DEFAULT_PASTE_OFFSET;
  const offsetY = intent.flowPosition
    ? intent.flowPosition.y - anchorNode.position.y
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
    type: CanvasNodeType;
    label?: string;
  }> = [];

  for (const node of clipboard) {
    const nodeId = idMap.get(node.id);
    if (!nodeId) continue;

    // Resolve label.
    const originalLabel = String(node.data?.label ?? '').trim();
    const nodeType = (node.type ?? 'note') as CanvasNodeType;
    // Keep the source's label (deduped) instead of regenerating one.
    // A node's label - whether an explicit user rename or an auto label
    // derived from its content/first message - already describes the
    // copy just as well, so deduping the original reads better instantly
    // and matches what post-paste preprocessing would regenerate anyway.
    // Only truly empty labels fall back to a generated placeholder.
    const label = originalLabel
      ? deduplicateLabel(originalLabel, existingLabels)
      : generateNextLabel(node.type || 'node', existingLabels);
    existingLabels.push(label);

    // Clone data.
    const clonedData = JSON.parse(JSON.stringify(node.data ?? {}));
    clonedData.label = label;
    clonedData.origin = { type: 'user-pasted' };
    // Stroke ids identify individual ink entries across selection, move,
    // erase, hover, and merge paths. A pasted sketch is a new identity
    // domain, so retaining source ids would create collisions if the copy is
    // later merged back into the original region.
    if (nodeType === 'sketch' && Array.isArray(clonedData.strokes)) {
      clonedData.strokes = clonedData.strokes.map(
        (stroke: Record<string, unknown>) => ({
          ...stroke,
          id: createId('stroke'),
        }),
      );
    }

    // Reset question node runtime state so the copy starts fresh -
    // UNLESS it's a forked copy (`__forkConversation`), in which case
    // `pasteNodes` already assigned a new threadId + status and queued a
    // server-side history fork, so we keep the conversation pointer and
    // only drop the transient marker.
    if (clonedData.type === 'question') {
      if (clonedData.__forkConversation) {
        delete clonedData.__forkConversation;
      } else {
        delete clonedData.status;
        delete clonedData.runAt;
        delete clonedData.threadId;
        delete clonedData.errorMessage;
        delete clonedData.responseSummary;
      }
    }

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
      // Paste / duplicate selects everything it created so the user can
      // immediately move it. `selectOnCreate: true` also opts question
      // nodes in, overriding their default no-auto-select policy.
      selectOnCreate: true,
    });
    traceNodes.push({ id: nodeId, type: nodeType, label });
  }

  // Remap clipboard edges onto the freshly created node ids. Endpoints
  // that point outside the clipboard set (e.g. a half-copied selection
  // where only the source was selected) are dropped silently.
  const createdEdges: Extract<
    CanvasCommand,
    { type: 'CONNECT_NODES' }
  >['edges'] = [];
  for (const edge of intent.clipboardEdges ?? []) {
    const newSource = idMap.get(edge.source);
    const newTarget = idMap.get(edge.target);
    if (!newSource || !newTarget) continue;
    // EdgeStyle is the source of truth, persisted on `edge.data.edgeStyle`
    // by `applyEdgeStyle`. Cloning it (when present) preserves color,
    // line-style, direction, etc. across paste.
    const rawStyle = (edge.data as { edgeStyle?: EdgeStyle } | undefined)
      ?.edgeStyle;
    createdEdges.push({
      id: createId('edge') as CanvasEdgeId,
      source: newSource,
      target: newTarget,
      ...(rawStyle ? { style: JSON.parse(JSON.stringify(rawStyle)) } : {}),
    });
  }

  const commands: CanvasCommand[] = [{ type: 'CREATE_NODES', nodes: created }];
  if (createdEdges.length > 0) {
    commands.push({ type: 'CONNECT_NODES', edges: createdEdges });
  }

  return {
    commands,
    trace:
      traceNodes.length > 0
        ? [{ action: 'node_created', nodes: traceNodes }]
        : [],
  };
}
