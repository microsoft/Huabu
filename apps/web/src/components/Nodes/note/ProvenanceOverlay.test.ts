// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { isPointInEditedBlockGutter } from './ProvenanceOverlay';

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
