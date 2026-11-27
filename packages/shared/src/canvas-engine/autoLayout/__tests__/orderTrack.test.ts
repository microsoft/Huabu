// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { orderTrack } from '../layoutOrder.js';

type Item = { id: string; at: number };

const order = (items: Item[], ranked: string[], block?: string[]): string[] =>
  orderTrack(
    items,
    (item) => item.id,
    (item) => item.at,
    new Map(ranked.map((id, index) => [id, index])),
    block ? new Set(block) : undefined,
  ).map((item) => item.id);

describe('orderTrack with a block of newcomers', () => {
  it('places the block at its leading coordinate, in coordinate order', () => {
    expect(
      order(
        [
          { id: 'u', at: 150 },
          { id: 'v', at: 350 },
          { id: 't1', at: 100 },
          { id: 't2', at: 200 },
          { id: 't3', at: 300 },
        ],
        ['t1', 't2', 't3'],
        ['u', 'v'],
      ),
    ).toEqual(['t1', 'u', 'v', 't2', 't3']);
  });

  // Peers lose their rank when a write renumbers their track, so they are
  // newcomers too; snapping can put the block exactly on one of them.
  it('keeps the block together when an unranked peer shares its leading coordinate', () => {
    for (const items of [
      [
        { id: 'u', at: 80 },
        { id: 't1', at: 80 },
        { id: 'v', at: 240 },
      ],
      [
        { id: 't1', at: 80 },
        { id: 'v', at: 240 },
        { id: 'u', at: 80 },
      ],
    ]) {
      expect(order(items, [], ['u', 'v'])).toEqual(['t1', 'u', 'v']);
    }
  });

  it('puts a ranked peer at the same coordinate before the block, as it does one newcomer', () => {
    const items = [
      { id: 'u', at: 80 },
      { id: 't1', at: 80 },
      { id: 'v', at: 240 },
    ];
    expect(order(items, ['t1'], ['u', 'v'])).toEqual(['t1', 'u', 'v']);
    expect(order(items.slice(0, 2), ['t1'])).toEqual(['t1', 'u']);
  });
});
