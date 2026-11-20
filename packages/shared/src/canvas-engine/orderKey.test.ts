// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  compareOrder,
  isOrderKey,
  keyBetween,
  keysBetween,
  keysInSequence,
} from './orderKey.js';

/** Deterministic pseudo-random numbers, so a failure reproduces. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('keyBetween', () => {
  it('gives a first key and keys before and after it', () => {
    const first = keyBetween(undefined, undefined);
    const after = keyBetween(first, undefined);
    const before = keyBetween(undefined, first);
    expect(before < first && first < after).toBe(true);
    expect([before, first, after].every(isOrderKey)).toBe(true);
  });

  it('always finds room between two adjacent keys', () => {
    let low = keyBetween(undefined, undefined);
    let high = keyBetween(low, undefined);
    for (let i = 0; i < 200; i++) {
      const middle = keyBetween(low, high);
      expect(low < middle && middle < high).toBe(true);
      if (i % 2) low = middle;
      else high = middle;
    }
  });

  it('keeps a list ordered through random insertions', () => {
    const next = random(7);
    const keys: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(next() * (keys.length + 1));
      keys.splice(at, 0, keyBetween(keys[at - 1], keys[at]));
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(isOrderKey)).toBe(true);
  });

  it('stays short when always appending or always prepending', () => {
    let top = keyBetween(undefined, undefined);
    let bottom = top;
    for (let i = 0; i < 5000; i++) {
      top = keyBetween(top, undefined);
      bottom = keyBetween(undefined, bottom);
    }
    expect(top.length).toBeLessThanOrEqual(4);
    expect(bottom.length).toBeLessThanOrEqual(4);
  });

  it('refuses bounds that leave no room or are not keys', () => {
    const key = keyBetween(undefined, undefined);
    expect(() => keyBetween(key, key)).toThrow();
    expect(() => keyBetween(keyBetween(key, undefined), key)).toThrow();
    expect(() => keyBetween('not a key', undefined)).toThrow();
  });
});

describe('keysBetween', () => {
  it('returns n ascending keys inside the bounds, the same every time', () => {
    const low = keyBetween(undefined, undefined);
    const high = keyBetween(low, undefined);
    for (const [a, b] of [
      [undefined, undefined],
      [low, undefined],
      [undefined, low],
      [low, high],
    ] as const) {
      const keys = keysBetween(a, b, 25);
      expect(keys).toHaveLength(25);
      expect([...keys].sort()).toEqual(keys);
      expect(new Set(keys).size).toBe(25);
      if (a) expect(keys[0] > a).toBe(true);
      if (b) expect(keys[24] < b).toBe(true);
      expect(keysBetween(a, b, 25)).toEqual(keys);
    }
    expect(keysBetween(low, high, 0)).toEqual([]);
  });
});

describe('keysInSequence', () => {
  const [a, b, c, d] = keysBetween(undefined, undefined, 4);

  it('keeps keys that are already ascending', () => {
    expect(keysInSequence([a, b, c, d])).toEqual([a, b, c, d]);
  });

  it('keys a sequence that has none, deterministically', () => {
    expect(keysInSequence([undefined, undefined, undefined])).toEqual(
      keysBetween(undefined, undefined, 3),
    );
  });

  it('gives only the entry without a key a new one, between its neighbours', () => {
    const keys = keysInSequence([a, undefined, b, c]);
    expect([keys[0], keys[2], keys[3]]).toEqual([a, b, c]);
    expect(a < keys[1] && keys[1] < b).toBe(true);
    const first = keysInSequence([undefined, a, b]);
    expect(first.slice(1)).toEqual([a, b]);
    expect(first[0] < a).toBe(true);
    const last = keysInSequence([a, b, undefined]);
    expect(last.slice(0, 2)).toEqual([a, b]);
    expect(last[2] > b).toBe(true);
  });

  it('re-keys the later of two equal keys and leaves the rest', () => {
    const keys = keysInSequence([a, b, b, c]);
    expect([keys[0], keys[1], keys[3]]).toEqual([a, b, c]);
    expect(b < keys[2] && keys[2] < c).toBe(true);
  });

  it('makes room between two equal keys for an entry placed between them', () => {
    const keys = keysInSequence([b, undefined, b, c]);
    expect(keys[0]).toBe(b);
    expect(keys[3]).toBe(c);
    expect(b < keys[1] && keys[1] < keys[2] && keys[2] < c).toBe(true);
  });

  it('replaces a value that is not an order key', () => {
    const keys = keysInSequence([a, 'bogus key', c]);
    expect(a < keys[1] && keys[1] < c).toBe(true);
  });

  it('always returns strictly ascending keys', () => {
    const next = random(11);
    const pool = keysBetween(undefined, undefined, 6);
    for (let round = 0; round < 300; round++) {
      const input = Array.from({ length: 12 }, () => {
        const pick = Math.floor(next() * (pool.length + 2));
        return pool[pick];
      });
      const keys = keysInSequence(input);
      expect(keys).toHaveLength(input.length);
      for (let i = 1; i < keys.length; i++)
        expect(keys[i - 1] < keys[i]).toBe(true);
    }
  });
});

describe('compareOrder', () => {
  it('orders by key and breaks a tie by id', () => {
    const [low, high] = keysBetween(undefined, undefined, 2);
    const items = [
      { key: high, id: 'a' },
      { key: low, id: 'z' },
      { key: low, id: 'b' },
    ];
    expect(items.sort(compareOrder).map((item) => item.id)).toEqual([
      'b',
      'z',
      'a',
    ]);
  });
});
