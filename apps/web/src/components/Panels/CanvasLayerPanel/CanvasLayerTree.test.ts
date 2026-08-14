// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { shouldOpenLayerInPreview } from './CanvasLayerTree';

describe('shouldOpenLayerInPreview', () => {
  const plainClick = { shiftKey: false, metaKey: false, ctrlKey: false };

  it('opens a layer in Preview during fullscreen', () => {
    expect(shouldOpenLayerInPreview(true, plainClick)).toBe(true);
  });

  it('keeps ordinary and modified clicks on Canvas selection semantics', () => {
    expect(shouldOpenLayerInPreview(false, plainClick)).toBe(false);
    expect(
      shouldOpenLayerInPreview(true, { ...plainClick, shiftKey: true }),
    ).toBe(false);
    expect(
      shouldOpenLayerInPreview(true, { ...plainClick, ctrlKey: true }),
    ).toBe(false);
    expect(
      shouldOpenLayerInPreview(true, { ...plainClick, metaKey: true }),
    ).toBe(false);
  });
});
