// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Container z-order - explicit render stacking derived from forest order.
 *
 * React Flow's default `zIndexMode: 'auto'` applies two implicit rules
 * that override authored `zIndex`:
 *   1. A child node is forced above its parent (`max(childZ, parentZ+1)`).
 *   2. Every top-level frame that owns children is lifted by a fixed band
 *      (`rootParentIndex * 10`), so the whole framed subtree floats above
 *      unframed siblings regardless of authored order.
 *
 * Together these make it impossible for a plain node to cover a frame's
 * children by ordering alone — a node ordered AFTER a frame still paints
 * BELOW that frame's contents. To make the Layers-panel / nodes-array
 * order the SOLE stacking authority we switch React Flow to
 * `zIndexMode="manual"` and assign every node an explicit z here.
 *
 * Pure topology helpers — no React Flow runtime state, no DOM.
 */

import { hasLiveParent, indexById, type NestableNode } from './tree.js';

/**
 * Assign an explicit render z-index to every node such that array order
 * is the sole stacking authority (later in the forest = painted on top).
 *
 * Traversal is depth-first over the parent/child forest — parents before
 * children, siblings in array order — so each subtree occupies a
 * CONTIGUOUS band of z values. Consequences, all matching "later = on
 * top":
 *   - A child is emitted immediately after its frame, so `childZ >
 *     frameZ` → children always paint above their own frame background.
 *   - Any node ordered after a frame in the forest gets a higher z than
 *     the frame's ENTIRE subtree → it covers the whole frame, not just
 *     the frame's background.
 *
 * The returned values are only meaningful under `zIndexMode="manual"`;
 * in `auto` mode React Flow would re-derive them.
 *
 * @param nodes Canvas nodes in their authoritative array order.
 * @returns Map of node id → z-index (contiguous 0..N-1 in forest order).
 */
export function assignNodeZIndices(
  nodes: readonly NestableNode[],
): Map<string, number> {
  const byId = indexById(nodes as NestableNode[]);

  const childrenByParent = new Map<string, string[]>();
  const roots: string[] = [];
  for (const n of nodes) {
    if (hasLiveParent(byId, n.id)) {
      // Non-null: hasLiveParent guarantees parentId resolves in byId.
      const parentId = n.parentId as string;
      const arr = childrenByParent.get(parentId) ?? [];
      arr.push(n.id);
      childrenByParent.set(parentId, arr);
    } else {
      roots.push(n.id);
    }
  }

  const z = new Map<string, number>();
  let counter = 0;
  const visited = new Set<string>();

  const visit = (id: string) => {
    if (visited.has(id)) return; // defensive: cycles are pre-broken upstream
    visited.add(id);
    z.set(id, counter++);
    const kids = childrenByParent.get(id);
    if (kids) for (const kid of kids) visit(kid);
  };

  for (const rootId of roots) visit(rootId);
  // Safety net for any node unreachable via the forest (e.g. a cycle that
  // slipped past normalizeTreeOrder): still hand it a stable z.
  for (const n of nodes) if (!z.has(n.id)) z.set(n.id, counter++);

  return z;
}

/**
 * Compute an edge's render z under `zIndexMode="manual"`.
 *
 * Mirrors React Flow's `auto`-mode edge formula (`getElevatedEdgeZIndex`)
 * minus the selection bump we don't use: an edge floats at the z of its
 * highest FRAMED endpoint so it paints above the frame background its
 * endpoints sit in. An edge between two top-level (unframed) nodes stays
 * at 0 — below all nodes — which is React Flow's default "edges under
 * nodes" behaviour.
 *
 * Under manual mode React Flow uses `edge.zIndex` verbatim, so callers
 * must write this value onto the edge for it to take effect.
 */
export function edgeZIndex(
  zByNode: ReadonlyMap<string, number>,
  byId: ReadonlyMap<string, NestableNode>,
  source: string,
  target: string,
): number {
  const sourceZ = hasLiveParent(byId, source) ? (zByNode.get(source) ?? 0) : 0;
  const targetZ = hasLiveParent(byId, target) ? (zByNode.get(target) ?? 0) : 0;
  return Math.max(sourceZ, targetZ);
}
