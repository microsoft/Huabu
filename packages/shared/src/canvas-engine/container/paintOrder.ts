// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Paint order as each node's own value.
 *
 * A node's `data.paintKey` ranks it among the children of its parent (the
 * root included): a higher key paints further in front. The `nodes` array
 * stays in that order, so everything that reads array order (rendering z,
 * the Layers panel, snapshots) keeps working, but the array is derived:
 * what is stored, sent and merged is one key per node.
 *
 * Commands keep expressing order the way they always did, by where they put
 * a node in the array. {@link settlePaintOrder} turns that into keys at the
 * end of a batch: a node without a usable key gets one for the place it
 * stands in, and nobody else is rewritten.
 */

import { compareOrder, isOrderKey, keysInSequence } from '../orderKey.js';

import type { NestableNode } from './tree.js';

/** The key a node paints by, or `undefined` when it has none yet. */
export function readPaintKey(node: NestableNode): string | undefined {
  const key = (node.data as Record<string, unknown> | undefined)?.paintKey;
  return isOrderKey(key) ? key : undefined;
}

function withPaintKey<T extends NestableNode>(node: T, key: string): T {
  return { ...node, data: { ...node.data, paintKey: key } };
}

/**
 * Each parent's children in paint order, given which of them have a usable
 * key. Keyed children order by key, then id. A child without a key stays
 * right after the sibling it follows in the array, which is where the
 * command that created or moved it put it.
 */
function siblingsInPaintOrder<T extends NestableNode>(
  nodes: readonly T[],
  keyOf: (node: T) => string | undefined,
): Map<string | null, T[]> {
  type Run = { head?: T; tail: T[] };
  const runs = new Map<string | null, Run[]>();
  for (const node of nodes) {
    const parentId = node.parentId ?? null;
    let list = runs.get(parentId);
    if (!list) runs.set(parentId, (list = [{ tail: [] }]));
    if (keyOf(node) === undefined) list[list.length - 1].tail.push(node);
    else list.push({ head: node, tail: [] });
  }
  const ordered = new Map<string | null, T[]>();
  for (const [parentId, list] of runs) {
    const [leading, ...keyed] = list;
    keyed.sort((a, b) =>
      compareOrder(
        { key: keyOf(a.head as T), id: (a.head as T).id },
        { key: keyOf(b.head as T), id: (b.head as T).id },
      ),
    );
    ordered.set(parentId, [
      ...leading.tail,
      ...keyed.flatMap((run) => [run.head as T, ...run.tail]),
    ]);
  }
  return ordered;
}

/**
 * The whole forest as one array: every parent's children in the given
 * order, each node directly followed by its own subtree. A parent therefore
 * precedes its children and a subtree is contiguous, which is the order
 * rendering derives z from. A node whose parent is not in the array is laid
 * out as a root. Returns `nodes` itself when it is already in that order.
 */
function arrange<T extends NestableNode>(
  nodes: readonly T[],
  ordered: ReadonlyMap<string | null, readonly T[]>,
): T[] {
  const present = new Set(nodes.map((node) => node.id));
  const next: T[] = [];
  const placed = new Set<string>();
  const place = (node: T): void => {
    if (placed.has(node.id)) return;
    placed.add(node.id);
    next.push(node);
    for (const child of ordered.get(node.id) ?? []) place(child);
  };
  for (const [parentId, siblings] of ordered) {
    if (parentId === null || !present.has(parentId))
      for (const node of siblings) place(node);
  }
  // A parent cycle has no root to start from; keep its members, in order.
  for (const siblings of ordered.values())
    for (const node of siblings) place(node);
  return next.every((node, index) => node === nodes[index])
    ? (nodes as T[])
    : next;
}

/**
 * The array in paint order by the keys the nodes carry. Writes no key.
 * Returns the same array when it is already in order.
 */
export function orderByPaintKeys<T extends NestableNode>(
  nodes: readonly T[],
): T[] {
  return arrange(nodes, siblingsInPaintOrder(nodes, readPaintKey));
}

/**
 * Give every node a paint key for the place it stands in, and return the
 * array in paint order.
 *
 * A node keeps its key unless it has none, or — given `previousNodes`, the
 * Space before the batch — it changed parent and still carries the key it
 * had under the old one. Such a node is keyed between the siblings it
 * stands between. A Space stored before keys existed is keyed the same way:
 * every node in its array order, the same keys on every read.
 */
export function settlePaintOrder<T extends NestableNode>(
  nodes: readonly T[],
  previousNodes?: readonly NestableNode[],
): T[] {
  const previous = previousNodes
    ? new Map(previousNodes.map((node) => [node.id, node]))
    : undefined;
  const keyOf = (node: T): string | undefined => {
    const key = readPaintKey(node);
    const before = previous?.get(node.id);
    if (
      key !== undefined &&
      before &&
      (before.parentId ?? null) !== (node.parentId ?? null) &&
      readPaintKey(before) === key
    )
      return undefined;
    return key;
  };
  const ordered = siblingsInPaintOrder(nodes, keyOf);
  const rekeyed = new Map<string | null, T[]>();
  for (const [parentId, siblings] of ordered) {
    const keys = keysInSequence(siblings.map(keyOf));
    rekeyed.set(
      parentId,
      siblings.map((node, index) =>
        readPaintKey(node) === keys[index]
          ? node
          : withPaintKey(node, keys[index]),
      ),
    );
  }
  return arrange(nodes, rekeyed);
}
