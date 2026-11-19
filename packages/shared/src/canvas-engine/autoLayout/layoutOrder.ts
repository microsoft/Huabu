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

/**
 * Existing members keep explicit order; newcomers are inserted by their placement coordinate.
 * Newcomers named in `block` enter together: they share the block's leading coordinate, so
 * established members never end up between them.
 */
export function orderTrack<T>(
  items: T[],
  idOf: (item: T) => string,
  positionOf: (item: T) => number,
  ranks: ReadonlyMap<string, number>,
  block?: ReadonlySet<string>,
): T[] {
  const known = items
    .flatMap((item) => {
      const rank = ranks.get(idOf(item));
      return rank === undefined ? [] : [{ item, rank }];
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
  const newcomers = items.filter((item) => !ranks.has(idOf(item)));
  const blockStart = Math.min(
    ...newcomers
      .filter((item) => block?.has(idOf(item)))
      .map((item) => positionOf(item)),
  );
  const anchorOf = (item: T) =>
    block?.has(idOf(item)) ? blockStart : positionOf(item);
  const incoming = newcomers.sort(
    (a, b) => anchorOf(a) - anchorOf(b) || positionOf(a) - positionOf(b),
  );
  const result: T[] = [];
  let cursor = 0;
  for (const item of known) {
    while (
      cursor < incoming.length &&
      anchorOf(incoming[cursor]) < positionOf(item)
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
