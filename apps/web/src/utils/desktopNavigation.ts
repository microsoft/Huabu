// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type {
  DesktopTabContext,
  DesktopTabNavigation,
} from '@huabu/shared/desktop-tabs';

export function desktopNavigation(
  context: DesktopTabContext | undefined,
  location: { pathname: string; search: string; hash: string; state?: unknown },
): DesktopTabNavigation | null {
  if (!context || context.role === 'shell') return null;
  const match = /^\/canvas\/([^/]+)\/?$/.exec(location.pathname);
  if (match) {
    const canvasId = decodeURIComponent(match[1]);
    return canvasId === context.canvasId
      ? null
      : {
          canvasId,
          search: location.search,
          hash: location.hash,
          state: location.state,
        };
  }
  if (context.role === 'space') {
    return {
      canvasId: null,
      homePath: location.pathname === '/setup' ? '/setup' : '/spaces',
    };
  }
  return null;
}

export function desktopNavigationPath(target: DesktopTabNavigation): string {
  return `${target.canvasId ? `/canvas/${encodeURIComponent(target.canvasId)}` : (target.homePath ?? '/spaces')}${target.search ?? ''}${target.hash ?? ''}`;
}
