// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  advanceStamps,
  normalizeSaveKey,
  parseNodeStamps,
  SaveIdReusedError,
  storedResultOutcome,
  validateSaveResult,
} from './save.js';

import type { SpaceStamps } from './save.js';

const base: SpaceStamps = {
  lineage: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e',
  floor: 5,
  version: 7,
  nodes: { stamped: { created: 6, membership: 7 } },
};
const key = {
  principalId: 'principal',
  operationId: '0b6f3c52-7d1e-4c7a-9f3b-2a6f0e9d4c11',
};

describe('advanceStamps', () => {
  it('returns the same node map when the topology did not change', () => {
    const nodes = [
      { id: 'old', parentId: 'frame' },
      { id: 'frame' },
      { id: 'stamped' },
    ];
    const next = advanceStamps(
      base,
      nodes,
      nodes.map((node) => ({ ...node, position: { x: 1, y: 1 } })),
      8,
    );
    expect(next.nodes).toBe(base.nodes);
    expect(next).toEqual({ ...base, version: 8 });
  });

  it('treats a missing, null and empty parent as the same membership', () => {
    const next = advanceStamps(
      base,
      [{ id: 'a' }, { id: 'b', parentId: null }, { id: 'c', parentId: '' }],
      [{ id: 'a', parentId: null }, { id: 'b' }, { id: 'c' }],
      8,
    );
    expect(next.nodes).toEqual({});
  });

  it('stamps creation and membership, and forgets removed nodes', () => {
    const next = advanceStamps(
      base,
      [{ id: 'old' }, { id: 'stamped' }, { id: 'frame' }],
      [
        { id: 'old', parentId: 'frame' },
        { id: 'frame' },
        { id: 'fresh', parentId: 'frame' },
        null,
        { type: 'no-id' },
      ],
      8,
    );
    expect(next).toEqual({
      ...base,
      version: 8,
      nodes: {
        old: { created: 5, membership: 8 },
        fresh: { created: 8, membership: 8 },
      },
    });
    // The input was not edited in place.
    expect(base.nodes).toEqual({ stamped: { created: 6, membership: 7 } });
  });
});

describe('save rules', () => {
  it('returns the serialized response it measured', () => {
    expect(
      validateSaveResult({
        key,
        digest: 'a'.repeat(64),
        response: { a: 1, drop: undefined },
      }),
    ).toBe('{"a":1}');
  });

  it('distinguishes a retry from a reused id', () => {
    const stored = { digest: 'a'.repeat(64), response: 1, atVersion: 2 };
    expect(
      storedResultOutcome(stored, { key, digest: stored.digest, response: 9 }),
    ).toEqual({ ok: false, reason: 'result-exists', stored });
    expect(() =>
      storedResultOutcome(stored, {
        key,
        digest: 'b'.repeat(64),
        response: 1,
      }),
    ).toThrow(SaveIdReusedError);
  });

  it('normalizes the request id and refuses malformed keys', () => {
    expect(
      normalizeSaveKey({ ...key, operationId: key.operationId.toUpperCase() }),
    ).toEqual(key);
    expect(() => normalizeSaveKey({ ...key, operationId: '../x' })).toThrow(
      TypeError,
    );
    expect(() => normalizeSaveKey({ ...key, principalId: '' })).toThrow(
      TypeError,
    );
  });

  it('refuses a persisted stamp map that is not one', () => {
    expect(parseNodeStamps({ a: { created: 1, membership: 2 } }, 'x')).toEqual({
      a: { created: 1, membership: 2 },
    });
    expect(() => parseNodeStamps([], 'x')).toThrow();
    expect(() => parseNodeStamps({ a: { created: '1' } }, 'x')).toThrow();
  });
});
