// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  computeDisplayDiffs,
  isPointInEditedBlockGutter,
} from './ProvenanceOverlay';

describe('computeDisplayDiffs', () => {
  it('renders top-level bullet items as separate rows', () => {
    const rows = computeDisplayDiffs('- alpha\n- beta', '- alpha\n- gamma');

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.map((segment) => segment.type))).toEqual([
      ['same'],
      ['removed'],
      ['added'],
    ]);
    expect(
      rows.map((row) => row.map((segment) => segment.text).join('')),
    ).toEqual(['- alpha', '- beta', '- gamma']);
  });

  it('keeps non-list markdown in one row', () => {
    expect(computeDisplayDiffs('old paragraph', 'new paragraph')).toHaveLength(
      1,
    );
  });
});

describe('isPointInEditedBlockGutter', () => {
  const slot = { top: 20, right: 200, height: 40 };

  it('excludes the edited block text body', () => {
    expect(isPointInEditedBlockGutter(150, 40, slot)).toBe(false);
    expect(isPointInEditedBlockGutter(200, 40, slot)).toBe(false);
  });

  it('includes a narrow area around the gutter marker', () => {
    expect(isPointInEditedBlockGutter(203, 20, slot)).toBe(true);
    expect(isPointInEditedBlockGutter(209, 40, slot)).toBe(true);
    expect(isPointInEditedBlockGutter(215, 60, slot)).toBe(true);
  });

  it('excludes points beyond the marker hit area', () => {
    expect(isPointInEditedBlockGutter(202, 40, slot)).toBe(false);
    expect(isPointInEditedBlockGutter(216, 40, slot)).toBe(false);
    expect(isPointInEditedBlockGutter(209, 61, slot)).toBe(false);
  });
});
