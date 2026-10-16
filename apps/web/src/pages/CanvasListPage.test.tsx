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
import { DesktopHomeMenu } from '../components/Shell/DesktopHomeMenu';
import { APP_NAME } from '../config/app';

import type { DesktopTabsSnapshot } from '@huabu/shared/desktop-tabs';
import type { ReactNode } from 'react';

const setCanvasCount = vi.fn();
const environment = vi.hoisted(() => ({
  electron: false,
  desktopHome: false,
  canChangeWorkspace: false,
  pickerSupported: false,
  syncing: false,
  workspaceId: 'workspace-1',
  error: null as string | null,
  otherPath: '/tmp/other-workspace',
  activate: vi.fn(),
  select: vi.fn(),
  pickFolder: vi.fn(),
  onHomeMenu:
    vi.fn<(listener: (position: { x: number } | null) => void) => () => void>(),
  command: vi.fn(),
  onState:
    vi.fn<(listener: (state: DesktopTabsSnapshot) => void) => () => void>(),
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
  Loading: ({ message }: { message?: string }) => (
    <div>{message ?? 'loading'}</div>
  ),
}));

vi.mock('../components/Common/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../components/Panels/Header/Header', () => ({
  Header: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
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

vi.mock('../hooks/useElectron', () => {
  const bridge = {
    tabs: {
      context: { role: 'home' },
      onHomeMenu: environment.onHomeMenu,
      command: environment.command,
      onState: environment.onState,
    },
  };
  return {
    isElectron: () => environment.electron,
    getElectronBridge: () => (environment.desktopHome ? bridge : undefined),
    requireDesktopTabSuccess: vi.fn(),
  };
});

vi.mock('../store/previewWorkspace/persistence', () => ({
  deleteWorkspace: vi.fn(),
}));

vi.mock('../api/workspace', () => ({ pickFolder: environment.pickFolder }));

vi.mock('../store/workspaceStore', () => {
  const getState = () => ({
    capabilities: { canChangeWorkspace: environment.canChangeWorkspace },
    setCanvasCount,
    workspacePath: '/tmp/test-workspace',
    workspaceId: environment.workspaceId,
    isSyncing: environment.syncing,
    error: environment.error,
    recentWorkspaces: [
      {
        workspaceId: 'workspace-1',
        name: 'Test workspace',
        path: '/tmp/test-workspace',
        active: true,
      },
      {
        workspaceId: 'workspace-2',
        name: 'Other workspace',
        path: environment.otherPath,
        active: false,
      },
    ],
    activateRecentWorkspace: environment.activate,
    selectWorkspace: environment.select,
  });
  return {
    useWorkspaceLabel: () => 'Test workspace',
    useFolderPickerSupported: () => environment.pickerSupported,
    useWorkspaceStore: Object.assign(
      (selector: (state: ReturnType<typeof getState>) => unknown) =>
        selector(getState()),
      { getState },
    ),
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  environment.electron = false;
  environment.desktopHome = false;
  environment.canChangeWorkspace = false;
  environment.pickerSupported = false;
  environment.syncing = false;
  environment.workspaceId = 'workspace-1';
  environment.error = null;
  environment.otherPath = '/tmp/other-workspace';
  environment.activate.mockResolvedValue(undefined);
  environment.select.mockResolvedValue(undefined);
  environment.pickFolder.mockResolvedValue({ ok: false, reason: 'cancelled' });
  environment.onHomeMenu.mockReturnValue(vi.fn());
  environment.command.mockResolvedValue({ ok: true });
  environment.onState.mockReturnValue(vi.fn());
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
      {
        path: '/spaces',
        element: (
          <>
            <CanvasListPage />
            {environment.desktopHome && <DesktopHomeMenu />}
          </>
        ),
      },
      { path: '/setup', element: <div data-testid="workspace-setup" /> },
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

async function openWorkspaceMenu() {
  await act(async () =>
    environment.onHomeMenu.mock.calls.at(-1)?.[0]({ x: 76 }),
  );
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error('Workspace menu was not rendered');
  return menu;
}

describe('CanvasListPage navigation', () => {
  it('refreshes the retained list after creation/import without leaving Home', async () => {
    environment.desktopHome = true;
    await renderPage();
    vi.mocked(listCanvases).mockResolvedValueOnce({
      canvases: [
        {
          canvasId: 'new-space',
          title: 'New or imported Space',
          nodeCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    await act(async () =>
      window.dispatchEvent(new Event('canvas-list-changed')),
    );
    expect(
      container.querySelector('a[href="/canvas/new-space"]')?.textContent,
    ).toContain('New or imported Space');
  });

  it('refreshes on returning from a Space without refetching for every status report', async () => {
    environment.desktopHome = true;
    await renderPage();
    const update = environment.onState.mock.calls.at(-1)?.[0];
    if (!update) throw new Error('Home state listener was not registered');
    const snapshot = (activeId: string): DesktopTabsSnapshot => ({
      activeId,
      workspaceId: 'workspace-1',
      busy: false,
      tabs: [],
    });
    await act(async () => update(snapshot('space-1')));
    vi.mocked(listCanvases).mockResolvedValueOnce({
      canvases: [
        {
          canvasId: 'space-1',
          title: 'Renamed in another renderer',
          nodeCount: 3,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    await act(async () => update(snapshot('home')));
    expect(
      container.querySelector('a[href="/canvas/space-1"]')?.textContent,
    ).toContain('Renamed in another renderer');
    expect(listCanvases).toHaveBeenCalledTimes(2);
    await act(async () => update(snapshot('home')));
    expect(listCanvases).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a newer list with an older response', async () => {
    await renderPage();
    let resolveOld!: (value: Awaited<ReturnType<typeof listCanvases>>) => void;
    vi.mocked(listCanvases).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    act(() => window.dispatchEvent(new Event('canvas-list-changed')));
    vi.mocked(listCanvases).mockResolvedValueOnce({
      canvases: [
        {
          canvasId: 'newer',
          title: 'Newer',
          nodeCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    await act(async () =>
      window.dispatchEvent(new Event('canvas-list-changed')),
    );
    await act(async () => resolveOld({ canvases: [] }));
    expect(container.querySelector('a[href="/canvas/newer"]')).not.toBeNull();
  });

  it('ignores a response from a Workspace that is no longer active', async () => {
    await renderPage();
    let resolveOld!: (value: Awaited<ReturnType<typeof listCanvases>>) => void;
    vi.mocked(listCanvases).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    act(() => window.dispatchEvent(new Event('canvas-list-changed')));
    environment.workspaceId = 'workspace-2';
    await act(async () =>
      resolveOld({
        canvases: [
          {
            canvasId: 'old-workspace-space',
            title: 'Stale',
            nodeCount: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    expect(
      container.querySelector('a[href="/canvas/old-workspace-space"]'),
    ).toBeNull();
    expect(setCanvasCount).toHaveBeenCalledTimes(1);
  });

  it('keeps the browser header and list heading unchanged', async () => {
    await renderPage();
    expect(container.querySelector('header h1')?.textContent).toBe(APP_NAME);
    expect(container.querySelector('main h2')?.textContent).toBe(
      'canvasList.title',
    );
    expect(container.querySelector('main h1')).toBeNull();
  });

  it('keeps Workspace and Settings controls out of the Spaces content heading', async () => {
    environment.electron = true;
    environment.desktopHome = true;
    environment.canChangeWorkspace = true;
    const { router } = await renderPage();
    expect(container.querySelector('header')).toBeNull();
    expect(container.querySelector('main h1')?.textContent).toBe(
      'canvasList.title',
    );
    expect(
      container.querySelector('button[aria-label="workspace.switcher"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Test workspace');
    expect(container.querySelector('main h2')).toBeNull();
    const settings = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="settings.open"]',
    );
    expect(settings).toHaveLength(0);
    const menu = await openWorkspaceMenu();
    expect(menu.querySelector('[aria-current="true"]')?.textContent).toContain(
      'Test workspace',
    );
    expect(router.state.location.pathname).toBe('/spaces');
  });

  it('does not offer Workspace switching when the desktop connection forbids it', async () => {
    environment.electron = true;
    environment.desktopHome = true;
    await renderPage();
    expect(container.querySelector('main h1')?.textContent).toBe(
      'canvasList.title',
    );
    const menu = await openWorkspaceMenu();
    expect(menu.textContent).toContain('Test workspace');
    expect(menu.querySelector('button:not(:disabled)')).toBeNull();
    expect(
      container.querySelector('[aria-label="workspace.switcher"]'),
    ).toBeNull();
    expect(container.querySelector('a[href="/setup"]')).toBeNull();
  });

  it('activates a recent Workspace directly without navigating to setup', async () => {
    environment.electron = true;
    environment.desktopHome = true;
    environment.canChangeWorkspace = true;
    const { router } = await renderPage();
    const menu = await openWorkspaceMenu();
    const items = menu.querySelectorAll<HTMLElement>('[role="menuitem"]');
    await act(async () => items[1].click());
    expect(environment.activate).toHaveBeenCalledExactlyOnceWith('workspace-2');
    expect(router.state.location.pathname).toBe('/spaces');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(environment.command).toHaveBeenCalledWith('close-home-menu');
  });

  it('does not save or reactivate the already-selected Workspace', async () => {
    environment.electron = true;
    environment.desktopHome = true;
    environment.canChangeWorkspace = true;
    await renderPage();
    const menu = await openWorkspaceMenu();
    const current = menu.querySelector<HTMLElement>('[aria-current="true"]');
    if (!current) throw new Error('Current Workspace was not marked');
    await act(async () => current.click());
    expect(environment.activate).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('supports arrow navigation and Escape with focus restoration', async () => {
    environment.electron = true;
    environment.desktopHome = true;
    environment.canChangeWorkspace = true;
    await renderPage();
    const menu = await openWorkspaceMenu();
    const items = menu.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(document.activeElement).toBe(items[0]);
    await act(async () =>
      items[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(items[1]);
    await act(async () =>
      items[1].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(environment.command).toHaveBeenCalledWith('close-home-menu');
  });

  it('keeps long paths truncated inside the menu rather than adding a trigger tooltip', async () => {
    environment.electron = true;
    environment.desktopHome = true;
    environment.canChangeWorkspace = true;
    environment.otherPath = `/tmp/${'long-folder/'.repeat(100)}workspace`;
    await renderPage();
    expect(container.querySelector('[title]')).toBeNull();
    const menu = await openWorkspaceMenu();
    const path = Array.from(menu.querySelectorAll('span')).find(
      (span) => span.textContent === environment.otherPath,
    );
    expect(path?.classList.contains('truncate')).toBe(true);
  });

  it.each([true, false])(
    'always opens the Home switch page with native picker support=%s',
    async (pickerSupported) => {
      environment.electron = true;
      environment.desktopHome = true;
      environment.canChangeWorkspace = true;
      environment.pickerSupported = pickerSupported;
      const { router } = await renderPage();
      const menu = await openWorkspaceMenu();
      const link = menu.querySelector<HTMLAnchorElement>('a[href="/setup"]');
      if (!link) throw new Error('Workspace setup link was not rendered');
      await act(async () => link.click());
      expect(router.state.location.pathname).toBe('/setup');
      expect(environment.pickFolder).not.toHaveBeenCalled();
      expect(environment.select).not.toHaveBeenCalled();
      expect(environment.activate).not.toHaveBeenCalled();
      expect(document.querySelector('[role="menu"]')).toBeNull();
    },
  );

  it('surfaces the localized activation failure without leaving the Spaces page', async () => {
    environment.electron = true;
    environment.desktopHome = true;
    environment.canChangeWorkspace = true;
    environment.error = 'Localized activation error';
    const error = new Error('Server detail');
    environment.activate.mockRejectedValue(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { router } = await renderPage();
      const menu = await openWorkspaceMenu();
      await act(async () =>
        menu.querySelectorAll<HTMLElement>('[role="menuitem"]')[1].click(),
      );
      expect(log).toHaveBeenCalledWith(
        '[workspace-switcher] Could not open Workspace:',
        error,
      );
      expect(toast).toHaveBeenCalledWith('Localized activation error', {
        tone: 'danger',
      });
      expect(router.state.location.pathname).toBe('/spaces');
      expect(document.querySelector('[role="menu"]')).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it('uses Workspace loading rather than a saving message during activation', async () => {
    environment.electron = true;
    environment.desktopHome = true;
    environment.syncing = true;
    const router = createMemoryRouter(
      [{ path: '/spaces', element: <CanvasListPage /> }],
      { initialEntries: ['/spaces'] },
    );
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(container.textContent).toBe('app.loadingWorkspace');
    expect(container.querySelector('a[href="/canvas/space-1"]')).toBeNull();
  });

  it('keeps standalone Electron chrome ownership unchanged', async () => {
    environment.electron = true;
    await renderPage();
    expect(container.querySelector('header')).toBeNull();
    expect(container.querySelector('main h2')?.textContent).toBe(
      'canvasList.title',
    );
    expect(
      container.querySelector('button[aria-label="settings.open"]'),
    ).toBeNull();
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
