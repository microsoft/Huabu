// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { canPlayVideoInline, isVideoControlTarget } from './videoInteraction';

const ordinary = {
  mode: 'overview' as const,
  isVisible: true,
  isSoleSelected: true,
  previewOpen: false,
  frameSuppressed: false,
};
describe('inline video interaction', () => {
  it('permits ordinary selected video without a reading-size requirement', () => {
    expect(canPlayVideoInline(ordinary)).toBe(true);
  });
  it.each([
    { mode: 'minimal' as const },
    { isVisible: false },
    { isSoleSelected: false },
    { previewOpen: true },
    { frameSuppressed: true },
  ])('denies playback for %o', (change) => {
    expect(canPlayVideoInline({ ...ordinary, ...change })).toBe(false);
  });
  it('claims only controls on the explicitly active video surface', () => {
    const surface = document.createElement('div');
    const video = document.createElement('video');
    surface.append(video);
    expect(isVideoControlTarget(video)).toBe(false);
    surface.dataset.videoControls = 'true';
    expect(isVideoControlTarget(video)).toBe(true);
    surface.dataset.videoControls = 'false';
    expect(isVideoControlTarget(video)).toBe(false);
    expect(isVideoControlTarget(null)).toBe(false);
  });
});
