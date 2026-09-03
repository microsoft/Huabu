// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CanvasListPage from './CanvasListPage';

import type { ReactNode } from 'react';

const setCanvasCount = vi.fn();

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
      workspacePath: string;
    }) => unknown,
  ) =>
    selector({
      capabilities: { canChangeWorkspace: false },
      setCanvasCount,
      workspacePath: '/tmp/test-workspace',
    }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
