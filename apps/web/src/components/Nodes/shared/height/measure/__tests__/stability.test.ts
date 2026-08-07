// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { awaitStableHeight, imagesDecoded } from '../stability';

describe('awaitStableHeight', () => {
  it('accepts a value only after two consecutive samples agree', async () => {
    // ProseMirror reflows asynchronously, so the first frame after a
    // document swap is routinely wrong.
    const samples = [0, 120, 260, 260, 260];
    let index = 0;
    const result = await awaitStableHeight({
      sample: () => samples[Math.min(index++, samples.length - 1)],
      imagesSettled: () => true,
    });
    expect(result).toEqual({ height: 260, provisional: false });
  });

  it('resolves provisionally when an image has not decoded', async () => {
    const result = await awaitStableHeight({
      sample: () => 260,
      imagesSettled: () => false,
      deadlineMs: 0,
    });
    expect(result).toEqual({ height: 260, provisional: true });
  });

  it('always drains, even when the height never settles', async () => {
    let height = 0;
    const result = await awaitStableHeight({
      sample: () => (height += 50),
      imagesSettled: () => true,
      deadlineMs: 0,
    });
    expect(result.provisional).toBe(true);
    expect(result.height).toBeGreaterThan(0);
  });
});

describe('imagesDecoded', () => {
  it('is true for a subtree with no images', () => {
    expect(imagesDecoded(document.createElement('div'))).toBe(true);
  });

  it('is false while an image is still loading', () => {
    const root = document.createElement('div');
    const image = document.createElement('img');
    Object.defineProperty(image, 'complete', { value: false });
    root.appendChild(image);
    expect(imagesDecoded(root)).toBe(false);
  });
});
