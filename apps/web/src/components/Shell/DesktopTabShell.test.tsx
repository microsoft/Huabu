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
      canChangeWorkspace: true,
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

  afterEach(async () => {
    await act(async () => {
      document.dispatchEvent(new Event('pointercancel'));
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    container.remove();
    vi.restoreAllMocks();
  });

  async function render() {
    await act(async () => root.render(<DesktopTabShell />));
  }

  it('keeps the title and close control inside one shared active Tab surface', async () => {
    await render();
    const tab = container.querySelector<HTMLElement>(
      '[role="tab"][aria-label="Space A"]',
    );
    const close = button('desktopTabs.closeTab');
    expect(tab?.parentElement).toBe(close.parentElement);
    expect(tab?.parentElement?.classList.contains('bg-bg-default')).toBe(true);
    expect(container.firstElementChild?.classList.contains('bg-surface')).toBe(
      true,
    );
    expect(tab?.parentElement?.classList.contains('border-r')).toBe(true);
    expect(tab?.parentElement?.classList.contains('rounded-md')).toBe(false);
    expect(tab?.classList.contains('enabled:hover:bg-transparent')).toBe(true);
    expect(tab?.classList.contains('text-[13px]')).toBe(true);
    expect(tab?.classList.contains('leading-5')).toBe(true);
    expect(tab?.classList.contains('font-normal')).toBe(true);
    expect(close.closest('button button')).toBeNull();
    expect(tab?.parentElement?.classList.contains('group/tab')).toBe(true);
    expect(close.classList.contains('opacity-0')).toBe(true);
    expect(close.classList.contains('group-hover/tab:opacity-100')).toBe(true);
    expect(
      close.classList.contains('group-has-[:focus-visible]/tab:opacity-100'),
    ).toBe(true);
    expect(close.classList.contains('[@media(hover:none)]:opacity-100')).toBe(
      true,
    );
    await act(async () => close.click());
    expect(mocks.close).toHaveBeenCalledWith('space-a');
    expect(mocks.activate).not.toHaveBeenCalled();
  });

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

  it('does not expose an opaque Space ID while its title is still unknown', async () => {
    snapshot.tabs[1].title = '';
    await render();
    const tab = button('canvasList.untitled');
    expect(tab.textContent).toBe('canvasList.untitled');
    expect(container.textContent).not.toContain('space-a');
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

  it('highlights selected Home like other Tabs without adding close-control padding', async () => {
    await render();
    const home = button('navigation.home');
    for (const activeId of ['space-a', 'home', 'space-a']) {
      await act(async () =>
        mocks.onState.mock.calls[0][0]({ ...snapshot, activeId }),
      );
      expect(home.parentElement?.classList.contains('bg-bg-default')).toBe(
        activeId === 'home',
      );
      expect(
        button('Space A').parentElement?.classList.contains('bg-bg-default'),
      ).toBe(activeId === 'space-a');
      expect(home.parentElement?.classList.contains('pr-1')).toBe(false);
      expect(home.classList.contains('w-10')).toBe(true);
      expect(home.getAttribute('aria-selected')).toBe(
        String(activeId === 'home'),
      );
    }
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

  it('opens a new Tab instead of navigating Home', async () => {
    await render();
    await act(async () => button('desktopTabs.newTab').click());
    expect(mocks.command).toHaveBeenCalledWith('new-tab');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(
      button('desktopTabs.newTab').parentElement?.classList.contains('ml-1'),
    ).toBe(true);
  });

  it('hides the Workspace button until switching is supported', async () => {
    snapshot.canChangeWorkspace = false;
    await render();
    expect(
      container.querySelector('[aria-label="workspace.switcher"]'),
    ).toBeNull();
    expect(button('settings.open')).toBeTruthy();
    await act(async () =>
      mocks.onState.mock.calls[0][0]({ ...snapshot, canChangeWorkspace: true }),
    );
    expect(button('workspace.switcher')).toBeTruthy();
  });

  it('insets only the new-Tab hover background without shrinking the shared icon button', async () => {
    await render();
    const add = button('desktopTabs.newTab');
    expect(add.classList.contains('before:inset-0.5')).toBe(true);
    expect(add.classList.contains('enabled:hover:bg-transparent')).toBe(true);
    expect(add.classList.contains('enabled:hover:before:bg-hover')).toBe(true);
    expect(add.classList.contains('p-1.5')).toBe(true);
    expect(add.className).toContain('[&_svg]:h-4');
    expect(add.querySelector('svg')?.classList.contains('relative')).toBe(true);
  });

  it('supports keyboard reordering without activating another Tab or moving Home', async () => {
    snapshot.tabs.push({
      ...snapshot.tabs[1],
      id: 'space-b',
      canvasId: 'b',
      title: 'Space B',
    });
    await render();
    await act(async () =>
      button('Space A').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          altKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    expect(mocks.command).toHaveBeenCalledWith({
      type: 'move-tab',
      id: 'space-a',
      index: 2,
    });
    expect(mocks.activate).not.toHaveBeenCalled();
    mocks.command.mockClear();
    await act(async () =>
      button('Space A').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          altKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    expect(mocks.command).not.toHaveBeenCalled();
    expect(button('navigation.home').getAttribute('aria-disabled')).not.toBe(
      'true',
    );
    expect(button('Space A').getAttribute('draggable')).toBeNull();
    expect(button('Space A').getAttribute('aria-roledescription')).toBe(
      'sortable',
    );
  });

  it.each([true, false])(
    'keeps keyboard focus and blocks pending actions when move success is %s',
    async (ok) => {
      let finish!: (
        result: { ok: true } | { ok: false; error: string },
      ) => void;
      mocks.command.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      await prepareDrag();
      const space = button('Space A');
      space.focus();
      const key = async (reorder: boolean) =>
        act(async () =>
          space.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'ArrowRight',
              altKey: reorder,
              shiftKey: reorder,
              bubbles: true,
            }),
          ),
        );
      await key(true);
      expect(space.disabled).toBe(false);
      expect(space.getAttribute('aria-disabled')).toBe('true');
      expect(button('navigation.home').getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(document.activeElement).toBe(space);
      await key(true);
      await key(false);
      await act(async () => {
        space.click();
        button('navigation.home').click();
        button('desktopTabs.closeTab').click();
      });
      expect(mocks.command).toHaveBeenCalledTimes(1);
      expect(mocks.activate).not.toHaveBeenCalled();
      expect(mocks.close).not.toHaveBeenCalled();
      await act(async () => {
        if (ok) {
          snapshot = {
            ...snapshot,
            tabs: [snapshot.tabs[0], snapshot.tabs[2], snapshot.tabs[1]],
          };
          mocks.onState.mock.calls[0][0](snapshot);
        }
        finish(ok ? { ok: true } : { ok: false, error: 'Move failed' });
      });
      expect(document.activeElement).toBe(space);
      expect(space.getAttribute('aria-disabled')).toBe('false');
      await key(false);
      expect(mocks.activate).toHaveBeenCalledWith({
        id: ok ? 'home' : 'space-b',
        focus: 'shell',
      });
    },
  );

  async function prepareDrag() {
    snapshot.tabs.push({
      ...snapshot.tabs[1],
      id: 'space-b',
      canvasId: 'b',
      title: 'Space B',
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const id =
          this.getAttribute('data-desktop-tab-id') ??
          this.closest('[data-desktop-tab-id]')?.getAttribute(
            'data-desktop-tab-id',
          );
        if (id === 'space-a') return new DOMRect(40, 0, 100, 35);
        if (id === 'space-b') return new DOMRect(140, 0, 100, 35);
        if (this.querySelector('[data-testid="desktop-tab-drag-overlay"]'))
          return new DOMRect(40, 0, 100, 35);
        return new DOMRect(0, 0, 40, 35);
      },
    );
    await render();
  }

  async function pointer(target: EventTarget, type: string, clientX: number) {
    await act(async () => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          clientX,
          clientY: 17,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  async function startDrag() {
    await pointer(button('Space A'), 'pointerdown', 70);
    await pointer(document, 'pointermove', 80);
    await pointer(document, 'pointermove', 180);
  }

  it('keeps a faded source and a labelled overlay during pointer dragging without activating the Tab', async () => {
    await prepareDrag();
    await startDrag();
    expect(
      document.querySelector('[data-testid="desktop-tab-drag-overlay"]')
        ?.textContent,
    ).toBe('Space A');
    expect(
      button('Space A').parentElement?.classList.contains('opacity-30'),
    ).toBe(true);
    expect(mocks.command).not.toHaveBeenCalled();
    await pointer(document, 'pointermove', 70);
    await pointer(document, 'pointerup', 70);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="desktop-tab-drag-overlay"]'),
    ).toBeNull();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it.each(['escape', 'blur', 'busy', 'removed'] as const)(
    'cancels a drag on %s without committing a move',
    async (reason) => {
      await prepareDrag();
      await startDrag();
      expect(
        document.querySelector('[data-testid="desktop-tab-drag-overlay"]'),
      ).not.toBeNull();
      await act(async () => {
        if (reason === 'escape')
          document.dispatchEvent(
            new KeyboardEvent('keydown', {
              code: 'Escape',
              key: 'Escape',
              bubbles: true,
            }),
          );
        else if (reason === 'blur') window.dispatchEvent(new Event('blur'));
        else
          mocks.onState.mock.calls[0][0]({
            ...snapshot,
            busy: reason === 'busy',
            tabs:
              reason === 'removed'
                ? snapshot.tabs.filter((tab) => tab.id !== 'space-a')
                : snapshot.tabs,
          });
      });
      await pointer(document, 'pointerup', 180);
      expect(
        document.querySelector('[data-testid="desktop-tab-drag-overlay"]'),
      ).toBeNull();
      expect(mocks.command).not.toHaveBeenCalled();
    },
  );

  it('projects a reorder while main acknowledges it, and rolls back a rejected move', async () => {
    let finish!: (result: { ok: false; error: string }) => void;
    mocks.command.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await prepareDrag();
    await act(async () =>
      button('Space A').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          altKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    const titles = () =>
      Array.from(container.querySelectorAll('[role="tab"]')).map((tab) =>
        tab.getAttribute('aria-label'),
      );
    expect(titles()).toEqual(['navigation.home', 'Space B', 'Space A']);
    await act(async () => mocks.onState.mock.calls[0][0](snapshot));
    expect(titles()).toEqual(['navigation.home', 'Space B', 'Space A']);
    await act(async () =>
      finish({ ok: false, error: 'Could not save Tab order' }),
    );
    expect(titles()).toEqual(['navigation.home', 'Space A', 'Space B']);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not save Tab order',
    );
  });

  it('does not start dragging from Home, a close control, or a busy Tab', async () => {
    await prepareDrag();
    for (const target of [
      button('navigation.home'),
      button('desktopTabs.closeTab'),
    ]) {
      await pointer(target, 'pointerdown', 70);
      await pointer(document, 'pointermove', 180);
      await pointer(document, 'pointerup', 180);
      expect(
        document.querySelector('[data-testid="desktop-tab-drag-overlay"]'),
      ).toBeNull();
    }
    await act(async () =>
      mocks.onState.mock.calls[0][0]({ ...snapshot, busy: true }),
    );
    await act(async () => {
      button('Space A').click();
      button('navigation.home').click();
      button('Space A').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      );
    });
    await startDrag();
    expect(
      document.querySelector('[data-testid="desktop-tab-drag-overlay"]'),
    ).toBeNull();
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('renders the blank Tab as a closable named Tab, not another Home icon', async () => {
    snapshot.tabs.push({
      ...snapshot.tabs[0],
      id: 'new-tab',
      title: 'New tab',
    });
    snapshot.activeId = 'new-tab';
    await render();
    const blank = container.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-label="desktopTabs.newTab"]',
    );
    expect(blank?.textContent).toBe('desktopTabs.newTab');
    expect(blank?.querySelector('svg')).toBeNull();
    const close = blank?.parentElement?.querySelector<HTMLButtonElement>(
      '[aria-label="desktopTabs.closeTab"]',
    );
    expect(close).toBeTruthy();
    await act(async () => close?.click());
    expect(mocks.close).toHaveBeenCalledWith('new-tab');
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
      'desktopTabs.newTab',
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
