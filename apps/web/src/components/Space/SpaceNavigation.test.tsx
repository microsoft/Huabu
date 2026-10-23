// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import { CanvasHeader } from '@/components/Panels/Header/CanvasHeader';

import { SpaceNavigation, SpaceReturnButton } from './SpaceNavigation';

const mocks = vi.hoisted(() => ({
  canvasId: 'child',
  resize: () => {},
  width: 800,
  refresh: vi.fn().mockResolvedValue(undefined),
  t: (key: string) => key,
  workspace: {
    workspaceId: 'workspace',
    worldCanvasId: 'world',
    spaceTitles: {
      root: 'Root',
      child: 'Child',
      leaf: 'Leaf',
      deep: 'Deep',
      tip: 'Tip',
      link: 'Unrelated shortcut source',
    },
    spaceSummaries: {
      root: {},
      child: { parentSpaceId: 'root', parentEntryNodeId: 'node-entry' },
      leaf: { parentSpaceId: 'child', parentEntryNodeId: 'node-leaf' },
      deep: { parentSpaceId: 'leaf' },
      tip: { parentSpaceId: 'deep' },
      link: {},
    },
    spaceTitlesError: null,
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/store/canvasStore', () => ({
  default: (selector: (state: { canvasId: string }) => unknown) =>
    selector({ canvasId: mocks.canvasId }),
  drainPendingSaves: vi.fn(),
}));
vi.mock('@/store/workspaceStore', () => ({
  useWorkspaceStore: (
    selector: (
      state: typeof mocks.workspace & {
        refreshSpaceTitles: typeof mocks.refresh;
      },
    ) => unknown,
  ) => selector({ ...mocks.workspace, refreshSpaceTitles: mocks.refresh }),
}));
vi.mock('./SpaceDeletionDialog', () => ({ SpaceDeletionDialog: () => null }));
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));
vi.mock('@/components/Panels/Header/AppMenu.tsx', () => ({
  AppMenu: () => <span>Logo</span>,
}));
vi.mock('@/components/Panels/Header/CanvasMenu.tsx', () => ({
  CanvasMenu: () => <span>Child</span>,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('returns through shortcut history without adding the source to canonical breadcrumbs', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Location() {
    return <output>{useLocation().pathname}</output>;
  }
  try {
    await act(async () =>
      root.render(
        <MemoryRouter
          initialEntries={[
            '/canvas/link',
            {
              pathname: '/canvas/child',
              state: { returnToSpace: 'link', workspaceId: 'workspace' },
            },
          ]}
          initialIndex={1}
        >
          <CanvasHeader isCollapsed onToggle={() => {}} />
          <Location />
        </MemoryRouter>,
      ),
    );
    expect(host.querySelector('nav a')?.textContent).toBe('Root');
    expect(host.querySelector('nav a[href="/canvas/link"]')).toBeNull();
    const back = host.querySelector<HTMLButtonElement>(
      'button[aria-label="spaceHierarchy.backTo"]',
    );
    expect(back).not.toBeNull();
    expect(back?.closest('nav')).toBeNull();
    const layers = host.querySelector<HTMLButtonElement>(
      'button[aria-label="layers.showPanel"]',
    );
    expect(layers).not.toBeNull();
    if (!back || !layers) throw new Error('Missing header actions');
    expect(back.compareDocumentPosition(layers)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(back?.className).toBe(layers?.className);
    expect(back?.querySelector('svg')?.classList.contains('h-4!')).toBe(true);
    await act(async () => back?.click());
    expect(host.querySelector('output')?.textContent).toBe('/canvas/link');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it.each([
  null,
  { returnToSpace: 'link', workspaceId: 'other' },
  { returnToSpace: 'child', workspaceId: 'workspace' },
])('does not show a return action for invalid history: %j', async (state) => {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[{ pathname: '/canvas/child', state }]}>
          <SpaceReturnButton />
        </MemoryRouter>,
      ),
    );
    expect(host.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(private callback: () => void) {}
    observe(target: Element) {
      if (target.tagName === 'NAV') mocks.resize = this.callback;
    }
    disconnect() {}
  },
);
afterEach(() => {
  vi.restoreAllMocks();
  mocks.refresh.mockClear();
  mocks.canvasId = 'child';
  mocks.width = 800;
});

it('integrates the existing title as the final crumb without management controls or child lists', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <SpaceNavigation>
            <input
              name="space-title"
              aria-label="Space title"
              defaultValue="Child"
            />
          </SpaceNavigation>
        </MemoryRouter>,
      ),
    );
    const nav = host.querySelector('nav');
    expect(nav?.classList.contains('text-[15px]')).toBe(true);
    expect(nav?.querySelector('a[href="/canvas/root"]')?.textContent).toBe(
      'Root',
    );
    expect(
      nav?.querySelector('[aria-current="page"] input')?.getAttribute('name'),
    ).toBe('space-title');
    expect(nav?.querySelector('a[href="/spaces"]')).toBeNull();
    expect(
      nav?.querySelector('[aria-hidden="true"]')?.textContent,
    ).not.toContain('Huabu Home');
    expect(nav?.textContent).not.toContain('Unrelated shortcut source');
    expect(host.querySelector('a[href="/canvas/leaf"]')).toBeNull();
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelectorAll('input')).toHaveLength(1);
    expect(host.textContent).not.toContain('spaceHierarchy.createChild');
    expect(mocks.refresh).toHaveBeenCalledOnce();
    mocks.canvasId = 'root';
    await act(async () =>
      root.render(
        <MemoryRouter>
          <SpaceNavigation>
            <span>Root</span>
          </SpaceNavigation>
        </MemoryRouter>,
      ),
    );
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe(
      'Root',
    );
    expect(host.querySelector('nav a')).toBeNull();
    expect(host.querySelector('nav')?.textContent).not.toContain('/');
  } finally {
    mocks.canvasId = 'child';
    await act(async () => root.unmount());
    host.remove();
  }
});

it('keeps the root and current Space while collapsing middle ancestors as width decreases', async () => {
  mocks.canvasId = 'tip';
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return {
        width: this.tagName === 'NAV' ? mocks.width : 100,
        height: 28,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 28,
        right: 100,
        toJSON() {},
      };
    },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const links = () =>
    [...host.querySelectorAll('nav a')].map((link) => link.textContent);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <SpaceNavigation>
            <span>Tip</span>
          </SpaceNavigation>
        </MemoryRouter>,
      ),
    );
    expect(links()).toEqual(['Root', 'Child', 'Leaf', 'Deep']);
    await act(async () => {
      mocks.width = 390;
      mocks.resize();
    });
    expect(links()).toEqual(['Root', 'Deep']);
    await act(async () => {
      mocks.width = 280;
      mocks.resize();
    });
    expect(links()).toEqual(['Root']);
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe(
      'Tip',
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button')?.click(),
    );
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.textContent,
      ),
    ).toEqual(['Child', 'Leaf', 'Deep']);
    await act(async () => {
      mocks.width = 800;
      mocks.resize();
    });
    expect(links()).toEqual(['Root', 'Child', 'Leaf', 'Deep']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
