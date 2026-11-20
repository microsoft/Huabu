// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { encodeBasis, parseBasis } from './basis.js';

const LINEAGE = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

describe('basis', () => {
  it('round-trips a lineage and version', () => {
    const encoded = encodeBasis(LINEAGE, 42);
    expect(encoded).toBe(`b1.${LINEAGE}.42`);
    expect(parseBasis(encoded)).toEqual({ lineage: LINEAGE, version: 42 });
    expect(parseBasis(encodeBasis(LINEAGE, 0))?.version).toBe(0);
  });

  it('normalizes the lineage case when encoding', () => {
    expect(encodeBasis(LINEAGE.toUpperCase(), 1)).toBe(`b1.${LINEAGE}.1`);
  });

  it('refuses to encode a malformed lineage or version', () => {
    expect(() => encodeBasis('not-a-uuid', 1)).toThrow(TypeError);
    expect(() => encodeBasis(LINEAGE, -1)).toThrow(TypeError);
    expect(() => encodeBasis(LINEAGE, 1.5)).toThrow(TypeError);
  });

  it.each([
    '',
    'b1',
    `b2.${LINEAGE}.1`,
    `b1.${LINEAGE}`,
    `b1.${LINEAGE}.01`,
    `b1.${LINEAGE}.-1`,
    `b1.${LINEAGE}.1.2`,
    `b1.${LINEAGE}.99999999999999999`,
    'b1.lineage.1',
    ` b1.${LINEAGE}.1`,
  ])('rejects %j', (value) => {
    expect(parseBasis(value)).toBeNull();
  });
});
