// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The one place the page keeps its `nodes` array in paint order.
 *
 * Paint order is each node's own `data.paintKey`; the array is derived from
 * the keys, and rendering z, the Layers panel and snapshots read the array.
 * Every write of the canvas store goes through the store's `set`, so the
 * array is put in key order there, and no write site has to remember to.
 *
 * Only the array is ordered. No key is written here: a node without a key
 * stays right after the sibling it follows, until the engine keys it.
 */

import { orderByPaintKeys, readPaintKey } from '@huabu/shared/canvas-engine';

import type { NestableNode } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';
import type { StateCreator } from 'zustand';

/**
 * Whether `next` can stand in another order than `previous` does: a node
 * was added, removed or moved to another slot, or changed its parent or its
 * paint key. A replacement that only changes other fields (a drag tick, a
 * selection, a content edit) answers `false` after one pass that allocates
 * nothing.
 */
function placementChanged(
  previous: readonly Node[],
  next: readonly Node[],
): boolean {
  if (previous.length !== next.length) return true;
  for (let index = 0; index < next.length; index++) {
    const before = previous[index];
    const after = next[index];
    if (before === after) continue;
    if (before.id !== after.id) return true;
    if ((before.parentId ?? null) !== (after.parentId ?? null)) return true;
    if (
      before.data !== after.data &&
      readPaintKey(before as NestableNode) !==
        readPaintKey(after as NestableNode)
    )
      return true;
  }
  return false;
}

/**
 * `next` in paint order, given the array it replaces, which is in paint
 * order already. Returns `next` itself when nothing that decides the order
 * changed, or when it is in order.
 */
export function nodesInPaintOrder(
  previous: readonly Node[],
  next: Node[],
): Node[] {
  if (next === previous || !placementChanged(previous, next)) return next;
  return orderByPaintKeys(next as NestableNode[]) as Node[];
}

/**
 * Store middleware: every `nodes` array written to the store, by an action's
 * `set` or by `setState` from outside, is stored in paint order.
 */
export const paintOrderMiddleware =
  <S extends { nodes: Node[] }>(config: StateCreator<S>): StateCreator<S> =>
  (set, get, api) => {
    // The `set` a store hands its creator is the store's own `setState`, so
    // wrapping it once covers both.
    const orderedSet = ((partial, replace) => {
      const state = get();
      const patch = typeof partial === 'function' ? partial(state) : partial;
      const nodes = patch.nodes;
      const ordered = nodes ? nodesInPaintOrder(state.nodes, nodes) : nodes;
      (set as (patch: S | Partial<S>, replace?: boolean) => void)(
        ordered === nodes ? patch : { ...patch, nodes: ordered },
        replace,
      );
    }) as typeof set;
    api.setState = orderedSet;
    return config(orderedSet, get, api);
  };
