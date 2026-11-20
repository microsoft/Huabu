// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reading order inside a Column / Row Frame, as each child's own value.
 *
 * A child stores which track it is in (`data.frameColumn` / `data.frameRow`)
 * and where it stands in that track (`data.trackKey`, an order key). Moving
 * one child therefore writes one child; the Frame holds no list. The solver
 * still works on, and returns, the tracks as lists of ids
 * ({@link FrameLayoutOrder}); these helpers turn the stored values into the
 * ranks it orders by and its result back into keys.
 */

import { compareOrder, isOrderKey, keysInSequence } from '../orderKey.js';

import type { FrameLayoutOrder } from '../../types/api/frame-layout.js';

type Keyed = { id: string; data?: Record<string, unknown> };

/** The key a child reads by inside its track, or `undefined` when it has none. */
export function readTrackKey(node: Keyed): string | undefined {
  const key = node.data?.trackKey;
  return isOrderKey(key) ? key : undefined;
}

/** `node` without the track key it held in the Frame it is leaving. */
export function withoutTrackKey<T extends Keyed>(node: T): T {
  if (!node.data || !('trackKey' in node.data)) return node;
  const { trackKey: _trackKey, ...data } = node.data;
  return { ...node, data };
}

/**
 * `next` data for a node whose data was `prev`: when the write moves the
 * node to another track and does not itself say where it reads there, the
 * key it held in the old track is dropped. The node is then placed by its
 * coordinate and keyed for that place by the relayout.
 */
export function dropTrackKeyOnTrackChange(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (
    next.trackKey === undefined ||
    next.trackKey !== prev.trackKey ||
    (next.frameColumn === prev.frameColumn && next.frameRow === prev.frameRow)
  )
    return next;
  const { trackKey: _trackKey, ...rest } = next;
  return rest;
}

/**
 * Rank of every child that has a track key: by stored track, then key, then
 * id. A child without a key has no rank and is placed by its coordinate
 * ({@link orderTrack}).
 */
export function trackOrderRanks<T extends Keyed>(
  children: readonly T[],
  trackOf: (child: T) => number | undefined,
  moved?: ReadonlySet<string>,
): Map<string, number> {
  const keyed = children
    .filter(
      (child) => readTrackKey(child) !== undefined && !moved?.has(child.id),
    )
    .map((child) => ({
      id: child.id,
      key: readTrackKey(child),
      track: trackOf(child) ?? 0,
    }))
    .sort((a, b) => a.track - b.track || compareOrder(a, b));
  return new Map(keyed.map((child, index) => [child.id, index]));
}

/**
 * The track keys that make the children read in `order`, for the children
 * whose key has to change. A child keeps its key when it still fits between
 * its neighbours; `moved` children are always keyed anew, so that moving one
 * child never rewrites the ones it passed.
 */
export function trackKeyChanges(
  order: FrameLayoutOrder,
  byId: ReadonlyMap<string, Keyed>,
  moved?: ReadonlySet<string>,
): Map<string, string> {
  const changes = new Map<string, string>();
  for (const track of order) {
    const current = track.map((id) => {
      const node = byId.get(id);
      return node && !moved?.has(id) ? readTrackKey(node) : undefined;
    });
    const keys = keysInSequence(current);
    track.forEach((id, index) => {
      const node = byId.get(id);
      if (node && readTrackKey(node) !== keys[index])
        changes.set(id, keys[index]);
    });
  }
  return changes;
}

/** Existing members keep explicit order; newcomers are inserted by their placement coordinate. */
export function orderTrack<T>(
  items: T[],
  idOf: (item: T) => string,
  positionOf: (item: T) => number,
  ranks: ReadonlyMap<string, number>,
): T[] {
  const known = items
    .flatMap((item) => {
      const rank = ranks.get(idOf(item));
      return rank === undefined ? [] : [{ item, rank }];
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
  const incoming = items
    .filter((item) => !ranks.has(idOf(item)))
    .sort((a, b) => positionOf(a) - positionOf(b));
  const result: T[] = [];
  let cursor = 0;
  for (const item of known) {
    while (
      cursor < incoming.length &&
      positionOf(incoming[cursor]) < positionOf(item)
    ) {
      result.push(incoming[cursor++]);
    }
    result.push(item);
  }
  result.push(...incoming.slice(cursor));
  return result;
}
