import {
  getAbsolutePosition,
  getDescendantIds,
  type NestableNode,
} from './frameHelper';
import { getLayoutNodeSize } from './nodeSize';
import { snapToGrid } from '../config/canvas';

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
 * independently repositioned – i.e. exclude descendants of any selected frame
 * because those travel with the frame as a single unit.
 */
function getAlignParticipants(nodes: Node[], selected: Node[]): Node[] {
  const selectedFrameIds = selected
    .filter((n) => n.type === 'frame')
    .map((n) => n.id);

  const descendantsOfSelectedFrames = new Set<string>();
  for (const fid of selectedFrameIds) {
    for (const did of getDescendantIds(nodes as NestableNode[], fid)) {
      descendantsOfSelectedFrames.add(did);
    }
  }

  return selected.filter((n) => !descendantsOfSelectedFrames.has(n.id));
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Align the selected nodes along the given direction.
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
): Node[] | null {
  const selected = nodes.filter((n) => n.selected);
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
        x: snapToGrid(newAbsX - offsetX),
        y: snapToGrid(newAbsY - offsetY),
      },
    };
  });
}

/**
 * Spread apart overlapping selected nodes so nothing overlaps.
 *
 * Returns a new `nodes` array (immutable) or `null` when no change is needed.
 *
 * Rules:
 * - Descendants of selected frames are excluded (they move with the frame).
 * - Nodes are grouped by `parentId` so frame children stay inside their frame.
 * - A greedy iterative resolver pushes colliding rectangles apart using the
 *   minimum-displacement direction.
 */
export function spreadNodes(nodes: Node[], gap = 24): Node[] | null {
  const selected = nodes.filter((n) => n.selected);
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
        x: snapToGrid(newAbs.x - offsetX),
        y: snapToGrid(newAbs.y - offsetY),
      },
    };
  });
}

/**
 * After resizing the node with `anchorId` (e.g. after fitting a frame to its
 * newly laid-out children), push all other top-level nodes away so nothing
 * overlaps. The anchor stays in place; every other root-level node absorbs
 * the displacement.
 *
 * Only top-level nodes (`parentId` is undefined / empty) participate.
 * Frame children keep their relative positions and travel with their parent.
 */
export function resolveTopLevelOverlaps(
  nodes: Node[],
  anchorId: string,
  gap = 32,
): Node[] {
  type Rect = {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    fixed: boolean;
  };

  const topLevel = nodes.filter((n) => !n.parentId);
  if (topLevel.length <= 1) return nodes;

  const rects: Rect[] = topLevel.map((n) => {
    const pos = getAbsPos(nodes, n);
    const { w, h } = getLayoutNodeSize(n);
    return { id: n.id, x: pos.x, y: pos.y, w, h, fixed: n.id === anchorId };
  });

  // Sort so the anchor is processed first (stable pivot)
  rects.sort((a, b) => {
    if (a.fixed && !b.fixed) return -1;
    if (!a.fixed && b.fixed) return 1;
    return a.x - b.x || a.y - b.y;
  });

  const MAX_ITERATIONS = 50;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let anyOverlap = false;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];

        // Center-based overlap computation
        const cxa = a.x + a.w / 2;
        const cxb = b.x + b.w / 2;
        const cya = a.y + a.h / 2;
        const cyb = b.y + b.h / 2;

        const overlapX = (a.w + b.w) / 2 + gap - Math.abs(cxb - cxa);
        const overlapY = (a.h + b.h) / 2 + gap - Math.abs(cyb - cya);

        if (overlapX > 0 && overlapY > 0) {
          anyOverlap = true;

          if (overlapX <= overlapY) {
            // Separate along x-axis
            const dir = cxb >= cxa ? 1 : -1;
            if (a.fixed) {
              b.x += dir * overlapX;
            } else {
              a.x -= (dir * overlapX) / 2;
              b.x += (dir * overlapX) / 2;
            }
          } else {
            // Separate along y-axis
            const dir = cyb >= cya ? 1 : -1;
            if (a.fixed) {
              b.y += dir * overlapY;
            } else {
              a.y -= (dir * overlapY) / 2;
              b.y += (dir * overlapY) / 2;
            }
          }
        }
      }
    }
    if (!anyOverlap) break;
  }

  const newPositions = new Map(rects.map((r) => [r.id, { x: r.x, y: r.y }]));
  const topLevelIds = new Set(topLevel.map((n) => n.id));

  return nodes.map((n) => {
    if (!topLevelIds.has(n.id)) return n;
    const newPos = newPositions.get(n.id);
    if (!newPos) return n;
    if (n.position.x === newPos.x && n.position.y === newPos.y) return n;
    return {
      ...n,
      position: {
        x: snapToGrid(newPos.x),
        y: snapToGrid(newPos.y),
      },
    };
  });
}
