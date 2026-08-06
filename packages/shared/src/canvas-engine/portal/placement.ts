// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  NODE_REF_COLLISION_GAP,
  NODE_REF_DEFAULT_HEIGHT,
  NODE_REF_DEFAULT_WIDTH,
  PORTAL_HEADER_INSET,
  PORTAL_SIDE_PADDING,
} from './geometry.js';
import { getNodeSize } from '../utils/nodeSizes.js';

import type {
  PreparedPortalSourcePosition,
  CanvasNodeId,
  Point,
} from '../../types/canvas/index.js';
import type { NestableNode } from '../container/tree.js';

interface SourceAnchor {
  nodeRef: NestableNode;
  sourcePosition: Point;
  sourceNodeId: string;
}

function sourceKey(canvasId: string, nodeId: string): string {
  return `${canvasId}\0${nodeId}`;
}

function nodeRefTarget(
  node: NestableNode,
): { canvasId: string; nodeId: string } | null {
  const target = (
    node.data as
      | { target?: { canvasId?: unknown; nodeId?: unknown } }
      | undefined
  )?.target;
  return typeof target?.canvasId === 'string' &&
    typeof target.nodeId === 'string'
    ? { canvasId: target.canvasId, nodeId: target.nodeId }
    : null;
}

function collides(position: Point, occupied: readonly NestableNode[]): boolean {
  const left = position.x;
  const top = position.y;
  const right = left + NODE_REF_DEFAULT_WIDTH;
  const bottom = top + NODE_REF_DEFAULT_HEIGHT;
  return occupied.some((node) => {
    const size = getNodeSize(node);
    return !(
      right + NODE_REF_COLLISION_GAP <= node.position.x ||
      node.position.x + size.width + NODE_REF_COLLISION_GAP <= left ||
      bottom + NODE_REF_COLLISION_GAP <= node.position.y ||
      node.position.y + size.height + NODE_REF_COLLISION_GAP <= top
    );
  });
}

function nearestOpenSlot(
  desired: Point,
  occupied: readonly NestableNode[],
): Point {
  if (!collides(desired, occupied)) return desired;

  const step = 32;
  for (let ring = 1; ring <= 64; ring += 1) {
    for (let y = -ring; y <= ring; y += 1) {
      for (let x = -ring; x <= ring; x += 1) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
        const candidate = {
          x: desired.x + x * step,
          y: desired.y + y * step,
        };
        if (!collides(candidate, occupied)) return candidate;
      }
    }
  }
  return {
    x: desired.x + (occupied.length + 1) * step,
    y: desired.y + (occupied.length + 1) * step,
  };
}

function compressedDelta(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: 96, y: 0 };
  const compressedDistance = Math.min(
    220,
    Math.max(72, Math.sqrt(distance) * 12),
  );
  return {
    x: (dx / distance) * compressedDistance,
    y: (dy / distance) * compressedDistance,
  };
}

export function placePortalNodeRef(
  nodes: NestableNode[],
  portalId: CanvasNodeId,
  sourceCanvasId: string,
  sourcePosition: Point,
  sourcePositions: readonly PreparedPortalSourcePosition[],
): Point {
  const positions = new Map(
    sourcePositions.map((entry) => [
      sourceKey(entry.sourceCanvasId, entry.sourceNodeId),
      entry.position,
    ]),
  );
  const occupied = nodes.filter((node) => node.parentId === portalId);
  const anchors: SourceAnchor[] = [];
  for (const node of occupied) {
    if (node.type !== 'nodeRef') continue;
    const target = nodeRefTarget(node);
    if (!target || target.canvasId !== sourceCanvasId) continue;
    const position = positions.get(sourceKey(target.canvasId, target.nodeId));
    if (!position) continue;
    anchors.push({
      nodeRef: node,
      sourcePosition: position,
      sourceNodeId: target.nodeId,
    });
  }

  let desired: Point = {
    x: PORTAL_SIDE_PADDING,
    y: PORTAL_HEADER_INSET,
  };
  if (anchors.length > 0) {
    anchors.sort((a, b) => {
      const da =
        (a.sourcePosition.x - sourcePosition.x) ** 2 +
        (a.sourcePosition.y - sourcePosition.y) ** 2;
      const db =
        (b.sourcePosition.x - sourcePosition.x) ** 2 +
        (b.sourcePosition.y - sourcePosition.y) ** 2;
      return da - db || a.sourceNodeId.localeCompare(b.sourceNodeId);
    });
    const anchor = anchors[0];
    const offset = compressedDelta(anchor.sourcePosition, sourcePosition);
    desired = {
      x: anchor.nodeRef.position.x + offset.x,
      y: anchor.nodeRef.position.y + offset.y,
    };
  }

  return nearestOpenSlot(desired, occupied);
}
