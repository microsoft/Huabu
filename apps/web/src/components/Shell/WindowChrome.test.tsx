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
import { getElectronBridge } from '../../hooks/useElectron';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../hooks/useElectron', () => ({
  getElectronBridge: vi.fn(),
}));
vi.mock('../../store/canvasStore', () => ({
  default: (select: (state: { canvasTitle: string }) => unknown) =>
    select({ canvasTitle: 'Test Canvas' }),
}));
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceLabel: () => 'Test Workspace',
  useWorkspaceStore: (
    select: (state: {
      workspacePath: string;
      capabilities: { canChangeWorkspace: boolean };
      canvasCount: number;
    }) => unknown,
  ) =>
    select({
      workspacePath: '/workspace',
      capabilities: { canChangeWorkspace: true },
      canvasCount: 1,
    }),
}));
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

describe('WindowChrome fullscreen visibility', () => {
  it('preserves the title-bar height in a normal canvas window', async () => {
    await renderChrome();

    expect(container.textContent).toContain('Test Canvas');
    expect(container.firstElementChild).toBeInstanceOf(HTMLDivElement);
    expect((container.firstElementChild as HTMLDivElement).style.height).toBe(
      '36px',
    );
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
      expect(isFullScreen).toHaveBeenCalledOnce();
    },
  );

  it('hides on entering fullscreen and restores on exiting', async () => {
    await renderChrome();
    expect(fullScreenListener).toBeDefined();

    act(() => fullScreenListener?.(true));
    expect(container.childElementCount).toBe(0);

    act(() => fullScreenListener?.(false));
    expect(container.textContent).toContain('Test Canvas');
  });

  it.each(['/spaces', '/setup', '/playground/design'])(
    'keeps the title bar on fullscreen non-canvas route %s',
    async (route) => {
      isFullScreen.mockResolvedValue(true);

      await renderChrome(route);

      expect(container.childElementCount).toBe(1);
    },
  );

  it('updates visibility when navigating without leaving fullscreen', async () => {
    isFullScreen.mockResolvedValue(true);
    await renderChrome();
    expect(container.childElementCount).toBe(0);

    await act(async () => navigate('/spaces'));
    expect(container.textContent).toContain('Test Workspace');

    await act(async () => navigate('/canvas/c2'));
    expect(container.childElementCount).toBe(0);
  });

  it('does not render title-bar chrome in the browser', async () => {
    vi.mocked(getElectronBridge).mockReturnValue(null);

    await renderChrome();

    expect(container.childElementCount).toBe(0);
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
  });

  it('unsubscribes even while the fullscreen title bar is hidden', async () => {
    isFullScreen.mockResolvedValue(true);
    await renderChrome();

    act(() => root.unmount());

    expect(unsubscribe).toHaveBeenCalledOnce();
    root = createRoot(container);
  });
});
