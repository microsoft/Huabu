// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DesktopTabShell from './DesktopTabShell';

import type { DesktopTabsSnapshot } from '@huabu/shared/desktop-tabs';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  onState: vi.fn(),
  activate: vi.fn(),
  close: vi.fn(),
  open: vi.fn(),
  command: vi.fn(),
  onHomeMenu: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useElectron', () => {
  const bridge = { platform: 'darwin', titleBarHeight: 36, tabs: mocks };
  return { getElectronBridge: () => bridge };
});
vi.mock('./UpdateButton', () => ({ UpdateButton: () => null }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('DesktopTabShell minimal Tab presentation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let snapshot: DesktopTabsSnapshot;

  beforeEach(() => {
    vi.clearAllMocks();
    snapshot = {
      workspaceId: 'workspace',
      activeId: 'space-a',
      busy: false,
      tabs: [
        {
          id: 'home',
          canvasId: null,
          title: 'Home',
          loading: false,
          running: false,
          unread: false,
          error: null,
        },
        {
          id: 'space-a',
          canvasId: 'a',
          title: 'Space A',
          loading: true,
          running: true,
          unread: true,
          error: 'An earlier Agent task failed',
        },
      ],
    };
    mocks.getState.mockResolvedValue(snapshot);
    mocks.onState.mockReturnValue(vi.fn());
    mocks.activate.mockResolvedValue({ ok: true });
    mocks.close.mockResolvedValue({ ok: true });
    mocks.open.mockResolvedValue({ ok: true });
    mocks.command.mockResolvedValue({ ok: true });
    mocks.onHomeMenu.mockReturnValue(vi.fn());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => root.render(<DesktopTabShell />));
  }

  function button(label: string): HTMLButtonElement {
    const element = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    if (!element) throw new Error(`Missing button: ${label}`);
    return element;
  }

  it('shows only a neutral title and close button regardless of activity/error metadata', async () => {
    await render();
    const tab = button('Space A');
    expect(tab.textContent).toBe('Space A');
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.querySelector('svg')).toBeNull();
    expect(tab.querySelector('.text-danger')).toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(
      container.querySelector('[aria-label="desktopTabs.reload"]'),
    ).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      container.querySelectorAll('[aria-label="desktopTabs.closeTab"]'),
    ).toHaveLength(1);
  });

  it('keeps activation and close operations intact', async () => {
    await render();
    await act(async () => button('Space A').click());
    expect(mocks.activate).toHaveBeenCalledWith('space-a');
    await act(async () => button('desktopTabs.closeTab').click());
    expect(mocks.close).toHaveBeenCalledWith('space-a');
  });

  it('restores the selected Tab focus after asynchronous keyboard activation', async () => {
    let complete!: (result: { ok: true }) => void;
    mocks.activate.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await render();
    const space = button('Space A');
    const home = button('navigation.home');
    space.focus();
    await act(async () =>
      space.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      ),
    );
    expect(mocks.activate).toHaveBeenCalledWith({ id: 'home', focus: 'shell' });
    space.focus();
    await act(async () => complete({ ok: true }));
    expect(document.activeElement).toBe(home);
  });

  it('shows Home as an accessible icon-only Tab', async () => {
    await render();
    const home = button('navigation.home');
    expect(home.textContent).toBe('');
    expect(home.querySelector('svg')).not.toBeNull();
    expect(home.parentElement?.querySelectorAll('button')).toHaveLength(1);
    await act(async () => home.click());
    expect(mocks.activate).toHaveBeenCalledWith('home');
    expect(mocks.command).not.toHaveBeenCalled();
    expect(home.getAttribute('aria-haspopup')).toBeNull();
    expect(home.getAttribute('aria-expanded')).toBeNull();
  });

  it('keeps Workspace immediately right of Settings in both Home and Space', async () => {
    await render();
    const workspace = button('workspace.switcher');
    expect(workspace.previousElementSibling).toBe(button('settings.open'));
    await act(async () =>
      mocks.onState.mock.calls[0][0]({ ...snapshot, activeId: 'home' }),
    );
    expect(button('workspace.switcher')).toBe(workspace);
    expect(workspace.textContent).toBe('');
    expect(workspace.querySelector('svg')).not.toBeNull();
    expect(workspace.previousElementSibling).toBe(button('settings.open'));
    expect(workspace.parentElement?.lastElementChild).toBe(workspace);
    expect(workspace.getAttribute('aria-haspopup')).toBe('menu');
    expect(workspace.getAttribute('aria-expanded')).toBe('false');
    await act(async () => workspace.click());
    expect(mocks.command).toHaveBeenCalledWith({
      type: 'open-home-menu',
      x: 0,
    });
    await act(async () => mocks.onHomeMenu.mock.calls[0][0]({ x: 0 }));
    expect(workspace.getAttribute('aria-expanded')).toBe('true');
    await act(async () => mocks.onHomeMenu.mock.calls[0][0](null));
    expect(workspace.getAttribute('aria-expanded')).toBe('false');
    await act(async () =>
      workspace.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      ),
    );
    expect(mocks.command).toHaveBeenCalledTimes(2);
    await act(async () =>
      mocks.onState.mock.calls[0][0]({
        ...snapshot,
        activeId: 'home',
        busy: true,
      }),
    );
    expect(workspace.disabled).toBe(true);
    await act(async () => mocks.onState.mock.calls[0][0](snapshot));
    expect(button('workspace.switcher')).toBe(workspace);
    expect(workspace.disabled).toBe(false);
  });

  it('keeps the open-Space action in the navigation strip', async () => {
    await render();
    await act(async () => button('desktopTabs.openSpace').click());
    expect(mocks.open).toHaveBeenCalledWith({ canvasId: null });
  });

  it('places Settings before Workspace and opens it in the active content page', async () => {
    await render();
    const settings = button('settings.open');
    expect(settings.textContent).toBe('');
    expect(settings.querySelector('svg')).not.toBeNull();
    expect(settings.nextElementSibling).toBe(button('workspace.switcher'));
    expect(
      container.querySelectorAll('[aria-label="settings.open"]'),
    ).toHaveLength(1);
    await act(async () => settings.click());
    expect(mocks.command).toHaveBeenCalledWith('open-settings');
  });

  it('uses the shared medium icon sizing for all Tab-strip icon controls', async () => {
    await render();
    for (const label of [
      'navigation.home',
      'desktopTabs.closeTab',
      'desktopTabs.openSpace',
      'settings.open',
      'workspace.switcher',
    ]) {
      expect(button(label).className).toContain('[&_svg]:h-4');
      expect(button(label).className).toContain('[&_svg]:w-4');
    }
  });

  it('still reports a rejected close separately from the neutral Tab title', async () => {
    mocks.close.mockResolvedValue({ ok: false, error: 'Disk full' });
    await render();
    await act(async () => button('desktopTabs.closeTab').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Disk full',
    );
    expect(button('Space A').querySelector('.text-danger')).toBeNull();
  });
});
