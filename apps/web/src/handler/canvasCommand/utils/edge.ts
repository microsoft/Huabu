/**
 * Edge-routing utilities for canvas commands.
 *
 * Provides smart handle selection and batch edge rerouting based on
 * the relative positions of source and target nodes.
 */

import { MarkerType, type Node, type Edge } from '@xyflow/react';

import { getLayoutNodeSize } from '@/utils/node/size';

import type { EdgeStyle } from '@sediment/shared';

/**
 * Returns the best source/target handle pair for an edge between two nodes
 * based on their relative positions on the canvas.
 *
 * Picks the handles that produce the most direct, least-crossing path:
 * - Target primarily to the right → right-source / left-target
 * - Target primarily to the left  → left-source  / right-target
 * - Target primarily below        → bottom-source / top-target
 * - Target primarily above        → top-source   / bottom-target
 */
export function getSmartHandles(
  sourceNode: Node,
  targetNode: Node,
): { sourceHandle: string; targetHandle: string } {
  const { w: sw, h: sh } = getLayoutNodeSize(sourceNode);
  const { w: tw, h: th } = getLayoutNodeSize(targetNode);

  const sx = sourceNode.position.x;
  const sy = sourceNode.position.y;
  const tx = targetNode.position.x;
  const ty = targetNode.position.y;

  // Center-to-center deltas
  const dx = tx + tw / 2 - (sx + sw / 2);
  const dy = ty + th / 2 - (sy + sh / 2);

  // Edge-to-edge gap: positive means no overlap on that axis.
  const hGap = Math.max(tx - (sx + sw), sx - (tx + tw));
  const vGap = Math.max(ty - (sy + sh), sy - (ty + th));

  // When nodes are clearly separated on one axis but overlap on the other,
  // always route along the separated axis — this prevents tall side-by-side
  // nodes from being connected vertically just because of a y-offset.
  const clearlyHorizontal = hGap > 0 && vGap <= 0;
  const clearlyVertical = hGap <= 0 && vGap > 0;
  const useHorizontal =
    clearlyHorizontal || (!clearlyVertical && Math.abs(dx) >= Math.abs(dy));

  if (useHorizontal) {
    return dx >= 0
      ? { sourceHandle: 'right-source', targetHandle: 'left-target' }
      : { sourceHandle: 'left-source', targetHandle: 'right-target' };
  } else {
    return dy >= 0
      ? { sourceHandle: 'bottom-source', targetHandle: 'top-target' }
      : { sourceHandle: 'top-source', targetHandle: 'bottom-target' };
  }
}

/**
 * Recalculate sourceHandle / targetHandle for every edge based on the
 * current relative positions of their source and target nodes.
 *
 * Returns the original `edges` reference when nothing changed, so React /
 * zustand can skip re-renders via reference equality.
 */
export function rerouteAllEdges<
  E extends {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  },
>(nodes: Node[], edges: E[]): E[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Resolve absolute positions so framed nodes are compared correctly
  // against nodes outside the frame (or in a different frame).
  const absPos = new Map<string, { x: number; y: number }>();
  const resolve = (nodeId: string): { x: number; y: number } | null => {
    const cached = absPos.get(nodeId);
    if (cached) return cached;
    const n = nodeMap.get(nodeId);
    if (!n) return null;
    if (!n.parentId) {
      absPos.set(nodeId, n.position);
      return n.position;
    }
    const parentAbs = resolve(n.parentId);
    if (!parentAbs) {
      absPos.set(nodeId, n.position);
      return n.position;
    }
    const abs = {
      x: parentAbs.x + n.position.x,
      y: parentAbs.y + n.position.y,
    };
    absPos.set(nodeId, abs);
    return abs;
  };

  let changed = false;
  const result = edges.map((edge) => {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) return edge;

    const sourceAbs = resolve(edge.source);
    const targetAbs = resolve(edge.target);
    if (!sourceAbs || !targetAbs) return edge;

    // Create position-adjusted node refs for handle calculation.
    const srcNode =
      sourceAbs === source.position
        ? source
        : { ...source, position: sourceAbs };
    const tgtNode =
      targetAbs === target.position
        ? target
        : { ...target, position: targetAbs };

    const handles = getSmartHandles(srcNode, tgtNode);
    if (
      edge.sourceHandle === handles.sourceHandle &&
      edge.targetHandle === handles.targetHandle
    ) {
      return edge;
    }
    changed = true;
    return { ...edge, ...handles };
  });
  return changed ? result : edges;
}

/**
 * Convert an EdgeStyle to React Flow edge properties.
 *
 * Stores the EdgeStyle as source of truth in `edge.data.edgeStyle` and
 * derives the React Flow rendering props (`type`, `style`, `animated`).
 */
export function applyEdgeStyle(edge: Edge, style?: EdgeStyle): Edge {
  if (!style) return edge;

  const rfStyle: Record<string, unknown> = {
    ...(typeof edge.style === 'object' ? edge.style : {}),
  };

  if (style.stroke) rfStyle.stroke = style.stroke;
  if (style.strokeWidth !== undefined) rfStyle.strokeWidth = style.strokeWidth;
  if (style.lineStyle === 'dashed') {
    rfStyle.strokeDasharray = '6 3';
  } else if (style.lineStyle === 'dotted') {
    rfStyle.strokeDasharray = '2 2';
  }

  // Map our domain lineType to React Flow edge type names
  const rfType = style.lineType === 'step' ? 'smoothstep' : style.lineType;

  // Build arrow markers based on direction
  const direction = style.direction ?? 'none';
  const markerColor = style.stroke ? { color: style.stroke } : {};
  const arrowMarker = { type: MarkerType.ArrowClosed, ...markerColor };

  return {
    ...edge,
    type: rfType ?? edge.type,
    animated: style.animated ?? edge.animated,
    style: rfStyle,
    markerEnd:
      direction === 'forward' || direction === 'both' ? arrowMarker : undefined,
    markerStart:
      direction === 'backward' || direction === 'both'
        ? arrowMarker
        : undefined,
    data: { ...edge.data, edgeStyle: style },
  };
}

/**
 * Merge a partial EdgeStyle patch into an existing EdgeStyle
 * stored on an edge's data, then re-apply to RF props.
 */
export function mergeEdgeStyle(edge: Edge, patch: Partial<EdgeStyle>): Edge {
  const existing: EdgeStyle =
    (edge.data?.edgeStyle as EdgeStyle | undefined) ?? {};
  const merged: EdgeStyle = { ...existing, ...patch };
  // Reset dash when lineStyle is explicitly set to solid
  if (patch.lineStyle === 'solid') {
    delete (merged as Record<string, unknown>).lineStyle;
  }
  return applyEdgeStyle(
    {
      ...edge,
      // Clear previously set RF style so applyEdgeStyle starts fresh
      style: {},
      type: undefined,
      animated: undefined,
    },
    merged,
  );
}
