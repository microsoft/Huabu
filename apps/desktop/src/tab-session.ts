// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { DesktopTabNavigation } from '@huabu/shared/desktop-tabs' with {
  'resolution-mode': 'import',
};

export interface TabSession {
  canvasIds: string[];
  activeCanvasId: string | null;
}

export function parseTabSession(raw: unknown): TabSession {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid Tab session');
  const value = raw as Record<string, unknown>;
  if (
    !Array.isArray(value.canvasIds) ||
    !value.canvasIds.every(isCanvasId) ||
    (value.activeCanvasId !== null && !isCanvasId(value.activeCanvasId))
  ) {
    throw new Error('Invalid Tab session identities');
  }
  const canvasIds = [...new Set(value.canvasIds as string[])];
  return {
    canvasIds,
    activeCanvasId:
      typeof value.activeCanvasId === 'string' &&
      canvasIds.includes(value.activeCanvasId)
        ? value.activeCanvasId
        : null,
  };
}

function isCanvasId(raw: unknown): raw is string {
  return (
    typeof raw === 'string' &&
    raw.length > 0 &&
    raw.length <= 256 &&
    !/[/\\?#\0]/.test(raw)
  );
}

export function parseTabNavigation(raw: unknown): DesktopTabNavigation {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid Tab target');
  const value = raw as Record<string, unknown>;
  if (value.canvasId !== null && !isCanvasId(value.canvasId)) {
    throw new Error('Invalid Space identity');
  }
  if (
    (value.search !== undefined &&
      (typeof value.search !== 'string' ||
        (value.search !== '' && !value.search.startsWith('?')))) ||
    (value.hash !== undefined &&
      (typeof value.hash !== 'string' ||
        (value.hash !== '' && !value.hash.startsWith('#')))) ||
    (value.homePath !== undefined &&
      value.homePath !== '/spaces' &&
      value.homePath !== '/setup')
  ) {
    throw new Error('Invalid Tab navigation');
  }
  if (JSON.stringify(value).length > 65_536) {
    throw new Error('Tab navigation is too large');
  }
  return {
    canvasId: value.canvasId as string | null,
    search: value.search as string | undefined,
    hash: value.hash as string | undefined,
    homePath: value.homePath as '/spaces' | '/setup' | undefined,
    state: value.state,
  };
}

export function tabUrl(origin: string, target: DesktopTabNavigation): string {
  const url = new URL(
    target.canvasId
      ? `/canvas/${encodeURIComponent(target.canvasId)}`
      : (target.homePath ?? '/spaces'),
    origin,
  );
  url.search = target.search ?? '';
  url.hash = target.hash ?? '';
  return url.href;
}

export function tabNavigationFromUrl(input: string): DesktopTabNavigation {
  const url = new URL(input);
  const canvas = url.pathname.match(/^\/canvas\/([^/]+)\/?$/);
  if (canvas)
    return parseTabNavigation({
      canvasId: decodeURIComponent(canvas[1]),
      search: url.search,
      hash: url.hash,
    });
  if (
    url.pathname === '/' ||
    url.pathname === '/spaces' ||
    url.pathname === '/setup'
  ) {
    return {
      canvasId: null,
      homePath: url.pathname === '/setup' ? '/setup' : '/spaces',
      search: url.search,
      hash: url.hash,
    };
  }
  throw new Error('Unsupported application navigation');
}
