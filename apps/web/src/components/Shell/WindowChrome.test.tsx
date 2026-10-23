// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MemoryRouter,
  useNavigate,
  type NavigateFunction,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WindowChrome } from './WindowChrome';
import { APP_NAME } from '../../config/app';
import { getElectronBridge } from '../../hooks/useElectron';
import useCanvasStore from '../../store/canvasStore';
import { useWorkspaceStore } from '../../store/workspaceStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../hooks/useElectron', () => ({
  getElectronBridge: vi.fn(),
}));
vi.mock('../../store/canvasStore', async () => {
  const { create } = await import('zustand');
  return {
    default: create(() => ({
      canvasId: 'c1',
      canvasTitle: 'Test Canvas',
      isLoading: false,
      canvasNotFound: false,
    })),
  };
});
vi.mock('../../store/workspaceStore', async () => {
  const { create } = await import('zustand');
  return {
    useWorkspaceLabel: () => 'Test Workspace',
    useWorkspaceStore: create(() => ({
      workspacePath: '/workspace',
      capabilities: { canChangeWorkspace: true },
      canvasCount: 1,
      spaceTitles: {},
    })),
  };
});
vi.mock('../../config/handbook', () => ({ openUserHandbook: vi.fn() }));
vi.mock('../Common/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../Settings/SettingsPopover', () => ({
  SettingsPopover: () => null,
}));
vi.mock('../Panels/Header/AppMenu', () => ({ AppMenu: () => null }));
vi.mock('./UpdateButton', () => ({ UpdateButton: () => null }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let navigate: NavigateFunction;
let fullScreenListener: ((fullScreen: boolean) => void) | undefined;
const unsubscribe = vi.fn();
const isFullScreen = vi.fn<() => Promise<boolean>>();

function NavigationProbe() {
  navigate = useNavigate();
  return null;
}

function chromeHeight() {
  return document.documentElement.style.getPropertyValue(
    '--window-chrome-height',
  );
}

async function renderChrome(route = '/canvas/c1') {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <NavigationProbe />
        <WindowChrome />
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  useCanvasStore.setState({
    canvasId: 'c1',
    canvasTitle: 'Test Canvas',
    isLoading: false,
    canvasNotFound: false,
  });
  useWorkspaceStore.setState({ spaceTitles: { c2: 'Next Space' } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fullScreenListener = undefined;
  unsubscribe.mockReset();
  isFullScreen.mockReset().mockResolvedValue(false);
  vi.mocked(getElectronBridge).mockReturnValue({
    versions: { node: '24.16.0', chrome: 'test', electron: '43.1.1' },
    isElectron: true,
    isRemoteServer: false,
    platform: 'darwin',
    titleBarHeight: 36,
    window: {
      isFullScreen,
      onFullScreenChange: (listener) => {
        fullScreenListener = listener;
        return unsubscribe;
      },
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('WindowChrome Space titles', () => {
  it('shows the destination title from the list before canvas loading starts', async () => {
    await renderChrome('/spaces');
    await act(async () => navigate('/canvas/c2'));

    expect(container.textContent).toContain('Next Space');
    expect(container.textContent).not.toContain('Test Canvas');

    act(() => useCanvasStore.setState({ canvasId: 'c2', isLoading: true }));
    expect(container.textContent).toContain('Next Space');
    expect(container.textContent).not.toContain('Test Canvas');

    act(() =>
      useCanvasStore.setState({
        canvasTitle: 'Loaded Space',
        isLoading: false,
      }),
    );
    expect(container.textContent).toContain('Loaded Space');

    act(() => useCanvasStore.setState({ canvasTitle: 'Renamed Space' }));
    expect(container.textContent).toContain('Renamed Space');
  });

  it('uses the app name for an unknown destination instead of the previous title', async () => {
    await renderChrome('/canvas/unknown');
    expect(container.textContent).toContain(APP_NAME);
    expect(container.textContent).not.toContain('Test Canvas');

    act(() =>
      useCanvasStore.setState({ canvasId: 'unknown', isLoading: true }),
    );
    expect(container.textContent).toContain(APP_NAME);
    expect(container.textContent).not.toContain('Test Canvas');
  });

  it('does not show the previous title when the destination is missing', async () => {
    useCanvasStore.setState({ canvasId: 'missing', canvasNotFound: true });
    await renderChrome('/canvas/missing');
    expect(container.textContent).toContain(APP_NAME);
    expect(container.textContent).not.toContain('Test Canvas');
  });
});

describe('WindowChrome fullscreen visibility', () => {
  it('preserves the title-bar height in a normal canvas window', async () => {
    await renderChrome();

    expect(container.textContent).toContain('Test Canvas');
    expect(container.firstElementChild).toBeInstanceOf(HTMLDivElement);
    expect((container.firstElementChild as HTMLDivElement).style.height).toBe(
      '36px',
    );
    expect(chromeHeight()).toBe('36px');
  });

  it.each(['darwin', 'win32', 'linux'] as const)(
    'omits the entire title-bar row on an initially fullscreen %s canvas',
    async (platform) => {
      const bridge = getElectronBridge();
      if (!bridge) throw new Error('Expected an Electron bridge');
      vi.mocked(getElectronBridge).mockReturnValue({ ...bridge, platform });
      isFullScreen.mockResolvedValue(true);

      await renderChrome();

      expect(container.childElementCount).toBe(0);
      expect(chromeHeight()).toBe('0px');
      expect(isFullScreen).toHaveBeenCalledOnce();
    },
  );

  it('hides on entering fullscreen and restores on exiting', async () => {
    await renderChrome();
    expect(fullScreenListener).toBeDefined();

    act(() => fullScreenListener?.(true));
    expect(container.childElementCount).toBe(0);
    expect(chromeHeight()).toBe('0px');

    act(() => fullScreenListener?.(false));
    expect(container.textContent).toContain('Test Canvas');
    expect(chromeHeight()).toBe('36px');
  });

  it.each(['/spaces', '/setup', '/playground/design'])(
    'keeps the title bar on fullscreen non-canvas route %s',
    async (route) => {
      isFullScreen.mockResolvedValue(true);

      await renderChrome(route);

      expect(container.childElementCount).toBe(1);
      expect(chromeHeight()).toBe('36px');
    },
  );

  it('updates visibility when navigating without leaving fullscreen', async () => {
    isFullScreen.mockResolvedValue(true);
    await renderChrome();
    expect(container.childElementCount).toBe(0);
    expect(chromeHeight()).toBe('0px');

    await act(async () => navigate('/spaces'));
    expect(container.textContent).toContain('Test Workspace');
    expect(chromeHeight()).toBe('36px');

    await act(async () => navigate('/canvas/c2'));
    expect(container.childElementCount).toBe(0);
    expect(chromeHeight()).toBe('0px');
  });

  it('does not render title-bar chrome in the browser', async () => {
    vi.mocked(getElectronBridge).mockReturnValue(null);

    await renderChrome();

    expect(container.childElementCount).toBe(0);
    expect(chromeHeight()).toBe('0px');
    expect(isFullScreen).not.toHaveBeenCalled();
  });

  it('keeps chrome visible when an older bridge has no window API', async () => {
    const bridge = getElectronBridge();
    if (!bridge) throw new Error('Expected an Electron bridge');
    vi.mocked(getElectronBridge).mockReturnValue({
      ...bridge,
      window: undefined,
    });

    await renderChrome();

    expect(container.textContent).toContain('Test Canvas');
    expect(chromeHeight()).toBe('36px');
  });

  it('unsubscribes even while the fullscreen title bar is hidden', async () => {
    isFullScreen.mockResolvedValue(true);
    await renderChrome();

    act(() => root.unmount());

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(chromeHeight()).toBe('');
    root = createRoot(container);
  });
});
