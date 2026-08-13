// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { resolveMultiSelectScale } from './MultiSelectResizer';

describe('resolveMultiSelectScale', () => {
  it('keeps free-axis scaling for selections without locked media', () => {
    expect(
      resolveMultiSelectScale({
        offX: 200,
        offY: 50,
        diag: { x: 100, y: 100 },
        diagLen2: 20_000,
        uniform: false,
      }),
    ).toEqual({ scaleX: 2, scaleY: 0.5 });
  });

  it('uses one scale when the selection contains aspect-locked media', () => {
    const scale = resolveMultiSelectScale({
      offX: 200,
      offY: 50,
      diag: { x: 100, y: 100 },
      diagLen2: 20_000,
      uniform: true,
    });

    expect(scale.scaleX).toBe(scale.scaleY);
    expect(scale).toEqual({ scaleX: 1.25, scaleY: 1.25 });
  });
});
