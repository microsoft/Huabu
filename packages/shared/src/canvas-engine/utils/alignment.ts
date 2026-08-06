// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getLayoutNodeSize } from './nodeSizes.js';
import {
  getAbsolutePosition,
  getDescendantIds,
  isContainerNode,
  type NestableNode,
} from '../container/index.js';

import type { Node } from '@xyflow/react';

// ── Types ──────────────────────────────────────────────────────────────

export type AlignDirection =
  | 'left'
  | 'center-h'
  | 'right'
  | 'top'
  | 'center-v'
  | 'bottom';

// ── Shared helpers ─────────────────────────────────────────────────────

/** Return the absolute position of a node (frame-aware). */
function getAbsPos(nodes: Node[], n: Node): { x: number; y: number } {
  const abs = getAbsolutePosition(nodes as NestableNode[], n.id);
  return abs ?? n.position;
}

/**
 * Given the full selected list, return only the nodes that should be
 * independently repositioned – i.e. exclude descendants of any selected
 * Container because those travel with the Container as a single unit.
 */
function getAlignParticipants(nodes: Node[], selected: Node[]): Node[] {
  const selectedContainerIds = selected
    .filter((node) => isContainerNode(node as NestableNode))
    .map((n) => n.id);

  const descendantsOfSelectedContainers = new Set<string>();
  for (const containerId of selectedContainerIds) {
    for (const descendantId of getDescendantIds(
      nodes as NestableNode[],
      containerId,
    )) {
      descendantsOfSelectedContainers.add(descendantId);
    }
  }

  return selected.filter(
    (node) => !descendantsOfSelectedContainers.has(node.id),
  );
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Align the specified nodes along the given direction.
 *
 * Returns a new `nodes` array (immutable) or `null` when no change is needed.
 *
 * Rules:
 * - When a frame is selected its children are NOT moved individually;
 *   the frame moves as an atomic unit.
 * - Bounding-box is computed from the *participants* only.
 */
export function alignNodes(
  nodes: Node[],
  direction: AlignDirection,
  nodeIds?: string[],
): Node[] | null {
  const targetIds = nodeIds ? new Set(nodeIds) : null;
  const selected = targetIds
    ? nodes.filter((n) => targetIds.has(n.id))
    : nodes.filter((n) => n.selected);
  if (selected.length < 2) return null;

  const participants = getAlignParticipants(nodes, selected);
  if (participants.length < 2) return null;

  // Compute bounding box of participants (absolute coords)
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const n of participants) {
    const pos = getAbsPos(nodes, n);
    const { w, h } = getLayoutNodeSize(n);
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + w);
    maxY = Math.max(maxY, pos.y + h);
  }

  const participantIds = new Set(participants.map((n) => n.id));

  return nodes.map((n) => {
    if (!participantIds.has(n.id)) return n;

    const absPos = getAbsPos(nodes, n);
    const { w, h } = getLayoutNodeSize(n);

    const offsetX = absPos.x - n.position.x;
    const offsetY = absPos.y - n.position.y;

    let newAbsX = absPos.x;
    let newAbsY = absPos.y;

    switch (direction) {
      case 'left':
        newAbsX = minX;
        break;
      case 'center-h':
        newAbsX = (minX + maxX) / 2 - w / 2;
        break;
      case 'right':
        newAbsX = maxX - w;
        break;
      case 'top':
        newAbsY = minY;
        break;
      case 'center-v':
        newAbsY = (minY + maxY) / 2 - h / 2;
        break;
      case 'bottom':
        newAbsY = maxY - h;
        break;
    }

    return {
      ...n,
      position: {
        x: newAbsX - offsetX,
        y: newAbsY - offsetY,
      },
    };
  });
}

/**
 * Spread apart overlapping nodes so nothing overlaps.
 *
 * Returns a new `nodes` array (immutable) or `null` when no change is needed.
 *
 * Rules:
 * - Descendants of selected frames are excluded (they move with the frame).
 * - Nodes are grouped by `parentId` so frame children stay inside their frame.
 * - A greedy iterative resolver pushes colliding rectangles apart using the
 *   minimum-displacement direction.
 */
export function spreadNodes(
  nodes: Node[],
  gap = 24,
  nodeIds?: string[],
): Node[] | null {
  const targetIds = nodeIds ? new Set(nodeIds) : null;
  const selected = targetIds
    ? nodes.filter((n) => targetIds.has(n.id))
    : nodes.filter((n) => n.selected);
  if (selected.length < 2) return null;

  const participants = getAlignParticipants(nodes, selected);
  if (participants.length < 2) return null;

  // Group by parentId so frame children stay in their frame
  const groups = new Map<string, Node[]>();
  for (const n of participants) {
    const key = n.parentId ?? '__root__';
    const arr = groups.get(key) ?? [];
    arr.push(n);
    groups.set(key, arr);
  }

  const finalAbsPositions = new Map<string, { x: number; y: number }>();

  type Rect = { id: string; x: number; y: number; w: number; h: number };

  for (const [, group] of groups) {
    if (group.length <= 1) {
      for (const n of group) {
        finalAbsPositions.set(n.id, getAbsPos(nodes, n));
      }
      continue;
    }

    const rects: Rect[] = group.map((n) => {
      const pos = getAbsPos(nodes, n);
      const { w, h } = getLayoutNodeSize(n);
      return { id: n.id, x: pos.x, y: pos.y, w, h };
    });

    // Deterministic order
    rects.sort((a, b) => a.x - b.x || a.y - b.y);

    // Greedy overlap resolver
    const MAX_ITERATIONS = 50;
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      let anyOverlap = false;
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];

          const overlapX = a.x < b.x + b.w + gap && a.x + a.w + gap > b.x;
          const overlapY = a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

          if (overlapX && overlapY) {
            anyOverlap = true;

            const pushRight = a.x + a.w + gap - b.x;
            const pushDown = a.y + a.h + gap - b.y;
            const pushLeft = b.x + b.w + gap - a.x;
            const pushUp = b.y + b.h + gap - a.y;

            const minPush = Math.min(pushRight, pushDown, pushLeft, pushUp);

            if (minPush === pushRight) {
              b.x = a.x + a.w + gap;
            } else if (minPush === pushDown) {
              b.y = a.y + a.h + gap;
            } else if (minPush === pushLeft) {
              b.x = a.x + a.w + gap;
            } else {
              b.y = a.y + a.h + gap;
            }
          }
        }
      }
      if (!anyOverlap) break;
    }

    for (const r of rects) {
      finalAbsPositions.set(r.id, { x: r.x, y: r.y });
    }
  }

  const participantIds = new Set(participants.map((n) => n.id));

  return nodes.map((n) => {
    if (!participantIds.has(n.id)) return n;
    const newAbs = finalAbsPositions.get(n.id);
    if (!newAbs) return n;

    const absPos = getAbsPos(nodes, n);
    const offsetX = absPos.x - n.position.x;
    const offsetY = absPos.y - n.position.y;

    return {
      ...n,
      position: {
        x: newAbs.x - offsetX,
        y: newAbs.y - offsetY,
      },
    };
  });
}
