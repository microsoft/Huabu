// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { computeDisplayDiffs } from './ProvenanceOverlay';

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
