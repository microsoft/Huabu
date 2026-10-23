// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CanvasListPage from './CanvasListPage';
import { ApiError } from '../api/_client';
import { exportCanvas, listCanvases } from '../api/canvas';
import { toast } from '../components/Common/Toast';

import type { ReactNode } from 'react';

const setCanvasCount = vi.fn();
const setSpaceTitle = vi.fn();
vi.mock('../i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('../components/Space/SpaceDeletionDialog', () => ({
  SpaceDeletionDialog: () => null,
}));

vi.mock('react-i18next', () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../api/canvas', () => ({
  deleteCanvasById: vi.fn(),
  exportCanvas: vi.fn(),
  listCanvases: vi.fn().mockResolvedValue({
    canvases: [
      {
        canvasId: 'space-1',
        title: 'Space One',
        nodeCount: 2,
        updatedAt: 0,
      },
    ],
  }),
}));

vi.mock('../components/Common/Toast', () => ({ toast: vi.fn() }));

vi.mock('../components/Common/Modal', () => ({
  Modal: () => null,
}));

vi.mock('../components/Common/Loading', () => ({
  Loading: () => <div>loading</div>,
}));

vi.mock('../components/Common/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../components/Panels/Header/Header', () => ({
  Header: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../hooks/useCanvasActions', () => ({
  useCanvasActions: () => ({
    create: vi.fn(),
    fileInputRef: { current: null },
    isCreating: false,
    isImporting: false,
    onFileChange: vi.fn(),
    openImportDialog: vi.fn(),
  }),
}));

vi.mock('../hooks/useElectron', () => ({
  isElectron: () => false,
}));

vi.mock('../store/previewWorkspace/persistence', () => ({
  deleteWorkspace: vi.fn(),
}));

vi.mock('../store/workspaceStore', () => ({
  useWorkspaceLabel: () => 'Test workspace',
  useWorkspaceStore: (
    selector: (state: {
      capabilities: { canChangeWorkspace: boolean };
      setCanvasCount: typeof setCanvasCount;
      setSpaceTitle: typeof setSpaceTitle;
      workspacePath: string;
    }) => unknown,
  ) =>
    selector({
      capabilities: { canChangeWorkspace: false },
      setCanvasCount,
      setSpaceTitle,
      workspacePath: '/tmp/test-workspace',
    }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/spaces', element: <CanvasListPage /> },
      {
        path: '/canvas/:canvasId',
        element: <div data-testid="canvas-route" />,
      },
    ],
    { initialEntries: ['/spaces'] },
  );

  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });

  const link = container.querySelector<HTMLAnchorElement>(
    'a[href="/canvas/space-1"]',
  );
  if (!link) throw new Error('Space card link was not rendered');
  return { link, router };
}

describe('CanvasListPage navigation', () => {
  it('uses a compact search field and keyboard-accessible segmented scope control', async () => {
    await renderPage();
    const search = container.querySelector('input[type="search"]');
    expect(search?.getAttribute('placeholder')).toBe(
      'spaceHierarchy.searchPlaceholder',
    );
    expect(search?.getAttribute('aria-label')).toBe('spaceHierarchy.search');
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[role="tablist"]')?.contains(search)).toBe(
      false,
    );
    await act(async () => {
      tabs[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(localStorage.getItem('huabu.spaces.showAll')).toBe('true');
  });
  it('searches nested Space names without matching ancestor names or paths', async () => {
    vi.mocked(listCanvases).mockResolvedValueOnce({
      canvases: [
        {
          canvasId: 'space-1',
          title: 'Parent',
          nodeCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
        {
          canvasId: 'child',
          title: 'Nested',
          parentSpaceId: 'space-1',
          nodeCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    await renderPage();
    const input = container.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    if (!input) throw new Error('Search input missing');
    const search = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await search('Parent');
    expect(container.querySelector('a[href="/canvas/space-1"]')).not.toBeNull();
    expect(container.querySelector('a[href="/canvas/child"]')).toBeNull();
    await search('  NESTED ');
    expect(container.querySelector('a[href="/canvas/space-1"]')).toBeNull();
    expect(container.querySelector('a[href="/canvas/child"]')).not.toBeNull();
    await search('Parent / Nested');
    expect(container.querySelector('a[href="/canvas/child"]')).toBeNull();
    await search('');
    expect(container.querySelector('a[href="/canvas/space-1"]')).not.toBeNull();
    expect(container.querySelector('a[href="/canvas/child"]')).toBeNull();
  });
  it('defaults to roots, remembers All, and exposes the canonical path for nested Spaces', async () => {
    vi.mocked(listCanvases).mockResolvedValueOnce({
      canvases: [
        {
          canvasId: 'space-1',
          title: 'Space One',
          nodeCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
        {
          canvasId: 'child',
          title: 'Nested',
          parentSpaceId: 'space-1',
          parentEntryNodeId: 'node-entry',
          nodeCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    await renderPage();
    expect(container.querySelector('a[href="/canvas/child"]')).toBeNull();
    const all = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'spaceHierarchy.all',
    );
    await act(async () => all?.click());
    expect(
      container.querySelector('a[href="/canvas/child"]')?.textContent,
    ).toContain('Space One /');
    expect(localStorage.getItem('huabu.spaces.showAll')).toBe('true');
  });
  it('shows the export refusal without leaving the Spaces list or reporting success', async () => {
    vi.mocked(exportCanvas).mockRejectedValueOnce(
      new ApiError(
        400,
        {
          code: 'STORAGE_CAPABILITY_UNAVAILABLE',
          message: 'Technical storage detail',
        },
        'Export failed',
      ),
    );
    const { router } = await renderPage();
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="canvasList.exportCanvas"]',
    );
    if (!button) throw new Error('Export control was not rendered');
    await act(async () => button.click());
    expect(router.state.location.pathname).toBe('/spaces');
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      'canvasList.exportUnavailable',
      { tone: 'danger' },
    );
    expect(button.disabled).toBe(false);
  });

  it('renders each Space card as a link and uses in-tab routing for a plain click', async () => {
    const { link, router } = await renderPage();

    expect(link.textContent).toContain('Space One');
    const event = new MouseEvent('click', {
      bubbles: true,
      button: 0,
      cancelable: true,
    });
    await act(async () => {
      link.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(router.state.location.pathname).toBe('/canvas/space-1');
    expect(setSpaceTitle).toHaveBeenCalledExactlyOnceWith(
      'space-1',
      'Space One',
    );
  });

  it.each([
    ['Ctrl-click', { ctrlKey: true, button: 0 }],
    ['Cmd-click', { metaKey: true, button: 0 }],
    ['middle-click', { button: 1 }],
  ])('leaves %s to native browser link handling', async (_name, init) => {
    const { link, router } = await renderPage();
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ...init,
    });

    await act(async () => {
      link.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(router.state.location.pathname).toBe('/spaces');
  });
});
