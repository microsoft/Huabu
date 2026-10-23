// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { desktopNavigation, desktopNavigationPath } from './desktopNavigation';

import type { DesktopTabContext } from '@huabu/shared/desktop-tabs';

const home: DesktopTabContext = {
  role: 'home',
  workspaceId: 'w',
  canvasId: null,
};
const space: DesktopTabContext = {
  role: 'space',
  workspaceId: 'w',
  canvasId: 'a',
};
const location = (pathname: string) => ({
  pathname,
  search: '?node=n',
  hash: '#section',
  state: { previewNode: { canvasId: 'b', nodeId: 'n' } },
});

describe('desktop navigation routing', () => {
  it('leaves browser and same-Space navigation unchanged', () => {
    expect(desktopNavigation(undefined, location('/canvas/a'))).toBeNull();
    expect(desktopNavigation(space, location('/canvas/a'))).toBeNull();
    expect(desktopNavigation(home, location('/setup'))).toBeNull();
  });

  it('opens Space routes in separate content pages without losing router state', () => {
    const target = desktopNavigation(space, location('/canvas/b'));
    expect(target).toEqual({
      canvasId: 'b',
      search: '?node=n',
      hash: '#section',
      state: location('').state,
    });
    expect(desktopNavigationPath(target!)).toBe('/canvas/b?node=n#section');
    expect(desktopNavigation(home, location('/canvas/b'))).toEqual(target);
  });

  it('returns to the existing Home for list and Workspace setup routes', () => {
    expect(desktopNavigation(space, location('/'))).toEqual({
      canvasId: null,
      homePath: '/spaces',
    });
    expect(desktopNavigation(space, location('/setup'))).toEqual({
      canvasId: null,
      homePath: '/setup',
    });
  });

  it('decodes and re-encodes Space identities without altering their meaning', () => {
    const target = desktopNavigation(home, location('/canvas/space%20a'));
    expect(target?.canvasId).toBe('space a');
    expect(desktopNavigationPath(target!)).toBe(
      '/canvas/space%20a?node=n#section',
    );
  });
});
