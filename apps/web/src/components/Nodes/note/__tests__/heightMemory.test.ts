// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { pinnedHeightOf } from '../heightMemory';

import type { Node } from '@xyflow/react';

function note(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    type: 'note',
    position: { x: 0, y: 0 },
    style: { width: 400 },
    data: { type: 'note' },
    ...overrides,
  } as Node;
}

describe('pinnedHeightOf', () => {
  it('records a height the user pinned', () => {
    expect(
      pinnedHeightOf(
        note({
          style: { width: 400, height: 700 },
          data: { type: 'note', heightMode: 'fixed' },
        }),
      ),
    ).toBe(700);
  });

  it('ignores a materialized auto height', () => {
    // This is the whole point of the guard: after the ownership model an
    // auto note carries a number too, and recording it would overwrite
    // the remembered pinned size with a measurement.
    expect(
      pinnedHeightOf(
        note({
          style: { width: 400, height: 260 },
          data: { type: 'note', heightMode: 'auto' },
        }),
      ),
    ).toBeUndefined();
  });

  it('treats a legacy note with a height as pinned', () => {
    expect(pinnedHeightOf(note({ style: { width: 400, height: 512 } }))).toBe(
      512,
    );
  });

  it('returns undefined for a legacy note with no height', () => {
    expect(pinnedHeightOf(note())).toBeUndefined();
  });

  it('returns undefined for a missing node', () => {
    expect(pinnedHeightOf(undefined)).toBeUndefined();
  });
});
