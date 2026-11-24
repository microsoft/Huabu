// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The order keys a stored Space is missing, as the nodes to store.
 *
 * A Space stored before nodes carried `data.paintKey` and `data.trackKey` is
 * given them once, when its Workspace is opened (Disk) or its database is
 * upgraded (SQLite, Postgres). This is the one rule both use, and it is
 * defined by the read: the keys are the ones `space(canvasId).read()` in
 * `storage/storage.ts` returns for the same stored record, so a page that
 * loaded before the keys were stored and one that loads after hold the same
 * keys.
 *
 * The read drops retired Portal / Pin nodes before it keys the rest. Those
 * nodes stay stored as they are, after the keyed ones, and a node the read
 * detaches from one keeps its stored parent and position: only `data` and
 * array order are written, which is all the keys are.
 */

import { stripLegacyPortalTopology } from '@huabu/shared';
import { seedNodeOrder } from '@huabu/shared/canvas-engine';

import type { CanvasFile } from './persistence-types.js';

type ReadNode = Parameters<typeof seedNodeOrder>[0][number];

/**
 * The stored nodes with their order keys, or `null` when the Space already
 * has them and nothing is to be written.
 */
export function storedNodesWithOrderKeys(
  state: CanvasFile['state'],
): unknown[] | null {
  const stored = state.nodes as ReadNode[];
  const read = stripLegacyPortalTopology(
    stored,
    state.edges as { source: string; target: string }[],
  ).nodes;
  const keyed = seedNodeOrder(read);
  if (keyed === read) return null;
  const storedById = new Map(stored.map((node) => [node.id, node]));
  const keyedIds = new Set(keyed.map((node) => node.id));
  return [
    ...keyed.map((node) => ({ ...storedById.get(node.id), data: node.data })),
    ...stored.filter((node) => !keyedIds.has(node.id)),
  ];
}

/**
 * The same as a rewrite of a stored state: the state with its order keys,
 * or `null` when it already has them. The SQL backends run it in the
 * upgrade to schema version 5 (`storage/ports/space-state-rewrites.ts`).
 */
export function stateWithOrderKeys(state: unknown): unknown | null {
  const stored = state as CanvasFile['state'];
  const nodes = storedNodesWithOrderKeys(stored);
  return nodes ? { ...stored, nodes } : null;
}
