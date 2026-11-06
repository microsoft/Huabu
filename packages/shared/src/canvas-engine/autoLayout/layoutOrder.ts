// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { FRAME_GRID_MAX_COUNT } from '../../types/canvas/node.js';

import type { FrameLayoutOrder } from '../../types/api/frame-layout.js';

export function readLayoutOrder(
  data: Record<string, unknown>,
): FrameLayoutOrder | undefined {
  const value = data.layoutOrder;
  if (value === undefined) return undefined;
  const seen = new Set<string>();
  if (
    !Array.isArray(value) ||
    value.length > FRAME_GRID_MAX_COUNT ||
    !value.every(
      (track) =>
        Array.isArray(track) &&
        track.every((id: unknown) => {
          if (typeof id !== 'string' || !id || seen.has(id)) return false;
          seen.add(id);
          return true;
        }),
    )
  ) {
    throw new Error(
      'Invalid Frame layoutOrder: expected unique child IDs in track lists.',
    );
  }
  return value;
}

export function sameLayoutOrder(
  a: FrameLayoutOrder | undefined,
  b: FrameLayoutOrder,
): boolean {
  return (
    !!a &&
    a.length === b.length &&
    a.every(
      (track, i) =>
        track.length === b[i].length && track.every((id, j) => id === b[i][j]),
    )
  );
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

export function remapLayoutOrder(
  order: FrameLayoutOrder,
  ids: ReadonlyMap<string, string>,
): FrameLayoutOrder {
  return order.map((track) =>
    track.flatMap((id) => {
      const mapped = ids.get(id);
      return mapped ? [mapped] : [];
    }),
  );
}
