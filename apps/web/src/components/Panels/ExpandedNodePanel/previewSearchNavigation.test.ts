// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerPreviewSearchNavigator,
  schedulePreviewSearchNavigation,
} from './previewSearchNavigation';

afterEach(() => {
  vi.useRealTimers();
});

describe('preview search navigation', () => {
  it('navigates immediately when the matching navigator is ready', () => {
    const navigateToMatch = vi.fn();
    const unregister = registerPreviewSearchNavigator('node-1', {
      query: 'needle',
      canNavigate: true,
      navigateToMatch,
    });

    schedulePreviewSearchNavigation('node-1', 'needle', 3);
    expect(navigateToMatch).toHaveBeenCalledWith(3);
    unregister();
  });

  it('waits for indexing to finish before navigating', () => {
    const navigateToMatch = vi.fn();
    const unregisterLoading = registerPreviewSearchNavigator('node-2', {
      query: 'needle',
      canNavigate: false,
      navigateToMatch,
    });
    schedulePreviewSearchNavigation('node-2', 'needle', 4);
    expect(navigateToMatch).not.toHaveBeenCalled();

    unregisterLoading();
    const unregisterReady = registerPreviewSearchNavigator('node-2', {
      query: 'needle',
      canNavigate: true,
      navigateToMatch,
    });
    expect(navigateToMatch).toHaveBeenCalledWith(4);
    unregisterReady();
  });

  it('does not navigate after a pending request is cancelled', () => {
    const navigateToMatch = vi.fn();
    const cancel = schedulePreviewSearchNavigation('node-3', 'needle', 1);
    cancel();
    const unregister = registerPreviewSearchNavigator('node-3', {
      query: 'needle',
      canNavigate: true,
      navigateToMatch,
    });
    expect(navigateToMatch).not.toHaveBeenCalled();
    unregister();
  });
});
