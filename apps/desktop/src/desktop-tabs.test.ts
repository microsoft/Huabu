// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopTabs, registerDesktopTabsIpc } from './desktop-tabs.js';

import type { DesktopTabReport } from '@huabu/shared/desktop-tabs' with {
  'resolution-mode': 'import',
};

interface TestContents {
  id: number;
  mainFrame: object;
  send: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  callbacks: Map<string, (...args: never[]) => void>;
}

interface TestView {
  webContents: TestContents;
  setVisible: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  views: [] as TestView[],
  options: [] as Electron.WebContentsViewConstructorOptions[],
  handlers: new Map<string, (...args: never[]) => unknown>(),
  listeners: new Map<string, (...args: never[]) => void>(),
  showErrorBox: vi.fn(),
  showMessageBox: vi.fn(),
  openExternal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: never[]) => unknown) =>
      mocks.handlers.set(channel, handler),
    on: (channel: string, listener: (...args: never[]) => void) =>
      mocks.listeners.set(channel, listener),
  },
  dialog: {
    showErrorBox: mocks.showErrorBox,
    showMessageBox: mocks.showMessageBox,
  },
  shell: { openExternal: mocks.openExternal },
  WebContentsView: class {
    webContents = {
      id: mocks.views.length + 1,
      mainFrame: {},
      send: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      reload: vi.fn(),
      focus: vi.fn(),
      toggleDevTools: vi.fn(),
      isDestroyed: () => false,
      callbacks: new Map<string, (...args: never[]) => void>(),
      on: (event: string, callback: (...args: never[]) => void) =>
        this.webContents.callbacks.set(event, callback),
      setWindowOpenHandler: vi.fn(),
    };
    setVisible = vi.fn();
    setBounds = vi.fn();
    constructor(options: Electron.WebContentsViewConstructorOptions) {
      mocks.options.push(options);
      mocks.views.push(this);
    }
  },
}));

describe('desktop Space Tab lifecycle', () => {
  let directory: string;
  let tabs: DesktopTabs;
  let shell: {
    webContents: TestContents;
    contentView: {
      addChildView: ReturnType<typeof vi.fn>;
      removeChildView: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.views.length = 0;
    mocks.options.length = 0;
    mocks.handlers.clear();
    mocks.listeners.clear();
    mocks.showMessageBox.mockReset().mockResolvedValue({ response: 1 });
    directory = mkdtempSync(join(tmpdir(), 'huabu-tabs-test-'));
    shell = {
      webContents: {
        id: 100,
        mainFrame: {},
        send: vi.fn(),
        loadURL: vi.fn(),
        close: vi.fn(),
        reload: vi.fn(),
        focus: vi.fn(),
        isDestroyed: () => false,
        callbacks: new Map(),
      },
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    };
    tabs = makeTabs();
    tabs.ready(mocks.views[0].webContents as never);
    tabs.workspaceReady(mocks.views[0].webContents as never, 'workspace');
  });

  afterEach(() => {
    tabs.dispose();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function makeTabs(origin = 'http://localhost:3001', remote = false) {
    return new DesktopTabs(
      {
        ...shell,
        on: vi.fn(),
        getContentSize: () => [1400, 900],
        isDestroyed: () => false,
      } as never,
      origin,
      directory,
      remote,
    );
  }

  function open(canvasId: string): TestView {
    tabs.open({ canvasId });
    const view = mocks.views.at(-1)!;
    tabs.ready(view.webContents as never);
    return view;
  }

  function finish(view: TestView, ok = true): void {
    const message = view.webContents.send.mock.calls.findLast(
      ([channel]) => channel === 'tabs:prepare-close',
    );
    expect(message).toBeDefined();
    tabs.finishDrain(
      view.webContents as never,
      message![1],
      ok ? { ok: true } : { ok: false, error: 'Disk full' },
    );
  }

  function crash(view: TestView): void {
    const handler = view.webContents.callbacks.get('render-process-gone');
    if (!handler) throw new Error('Missing renderer failure handler');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      handler({} as never, { reason: 'crashed' } as never);
    } finally {
      log.mockRestore();
    }
  }

  const report = (patch: Partial<DesktopTabReport> = {}): DesktopTabReport => ({
    title: 'Space',
    running: false,
    completion: '',
    error: null,
    ...patch,
  });

  it('notifies the retained Home renderer when a Space is activated and Home is selected again', () => {
    open('space-a');
    const home = mocks.views[0].webContents;
    expect(home.send).toHaveBeenCalledWith(
      'tabs:state',
      expect.objectContaining({
        activeId: tabs.snapshot.activeId,
      }),
    );
    tabs.activate('home');
    expect(home.send).toHaveBeenLastCalledWith(
      'tabs:state',
      expect.objectContaining({
        activeId: 'home',
        busy: false,
      }),
    );
  });

  it('opens the Home menu in Home, not underneath a Space view', () => {
    const space = open('space-a');
    tabs.command({ type: 'open-home-menu', x: 76 }, shell.webContents as never);
    expect(tabs.snapshot.activeId).toBe('home');
    expect(mocks.views[0].webContents.send).toHaveBeenCalledWith(
      'tabs:home-menu',
      { x: 76 },
    );
    expect(shell.webContents.send).toHaveBeenCalledWith('tabs:home-menu', {
      x: 76,
    });
    expect(space.webContents.send).not.toHaveBeenCalledWith(
      'tabs:home-menu',
      expect.anything(),
    );
  });

  it('toggles the Home menu and restores Shell focus on Escape', () => {
    tabs.command({ type: 'open-home-menu', x: 76 }, shell.webContents as never);
    tabs.command('close-home-menu', mocks.views[0].webContents as never);
    expect(shell.webContents.send).toHaveBeenLastCalledWith(
      'tabs:home-menu',
      null,
    );
    expect(shell.webContents.focus).toHaveBeenCalledOnce();
    tabs.command({ type: 'open-home-menu', x: 76 }, shell.webContents as never);
    tabs.command({ type: 'open-home-menu', x: 76 }, shell.webContents as never);
    expect(shell.webContents.send).toHaveBeenLastCalledWith(
      'tabs:home-menu',
      null,
    );
    expect(shell.webContents.focus).toHaveBeenCalledTimes(2);
  });

  it('dismisses on an outside press without stealing focus', () => {
    tabs.command({ type: 'open-home-menu', x: 76 }, shell.webContents as never);
    tabs.command('dismiss-home-menu', mocks.views[0].webContents as never);
    expect(shell.webContents.send).toHaveBeenLastCalledWith(
      'tabs:home-menu',
      null,
    );
    expect(shell.webContents.focus).not.toHaveBeenCalled();
  });

  it('closes Home menus when another Tab or Settings is opened', () => {
    open('space-a');
    tabs.command({ type: 'open-home-menu', x: 76 }, shell.webContents as never);
    const spaceId = tabs.snapshot.tabs.find(
      (tab) => tab.canvasId === 'space-a',
    )?.id;
    if (!spaceId) throw new Error('Space Tab was not created');
    tabs.activate(spaceId);
    expect(
      mocks.views[0].webContents.send.mock.calls.findLast(
        ([channel]) => channel === 'tabs:home-menu',
      ),
    ).toEqual(['tabs:home-menu', null]);
    tabs.command({ type: 'open-home-menu', x: 76 }, shell.webContents as never);
    tabs.command('open-settings', shell.webContents as never);
    expect(shell.webContents.send).toHaveBeenLastCalledWith(
      'tabs:home-menu',
      null,
    );
    expect(mocks.views[0].webContents.send).toHaveBeenLastCalledWith(
      'menu:command',
      'open-settings',
    );
  });

  it.each([-1, NaN, Infinity, 1401])(
    'rejects an invalid Home menu anchor: %s',
    (x) => {
      expect(() =>
        tabs.command({ type: 'open-home-menu', x }, shell.webContents as never),
      ).toThrow('Invalid Home menu position');
    },
  );

  it('does not allow Space renderers to open or dismiss the Home menu', () => {
    const space = open('space-a');
    expect(() =>
      tabs.command(
        { type: 'open-home-menu', x: 76 },
        space.webContents as never,
      ),
    ).toThrow('Only the desktop shell');
    expect(() =>
      tabs.command('close-home-menu', space.webContents as never),
    ).toThrow('Only Home or the desktop shell');
  });

  it('keeps independent content pages alive and deduplicates navigation', () => {
    const a = open('a');
    const b = open('b');
    tabs.open({ canvasId: 'a', search: '?node=n1', state: { selected: 'n1' } });
    expect(tabs.snapshot.tabs.map((tab) => tab.canvasId)).toEqual([
      null,
      'a',
      'b',
    ]);
    expect(mocks.views).toHaveLength(3);
    expect(a.webContents.close).not.toHaveBeenCalled();
    expect(b.webContents.close).not.toHaveBeenCalled();
    expect(a.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(a.webContents.send).toHaveBeenCalledWith(
      'tabs:navigate',
      expect.objectContaining({
        search: '?node=n1',
        state: { selected: 'n1' },
      }),
    );
    expect(a.setVisible).toHaveBeenLastCalledWith(true);
    expect(b.setVisible).toHaveBeenLastCalledWith(false);
    expect(a.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 36,
      width: 1400,
      height: 864,
    });
    expect(mocks.options[1].webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    });
  });

  it('saves before destroying a Tab and makes repeated close idempotent', async () => {
    const a = open('a');
    const id = tabs.snapshot.activeId;
    const close = tabs.close(id);
    expect(tabs.close(id)).toBe(close);
    expect(a.webContents.close).not.toHaveBeenCalled();
    finish(a);
    await close;
    expect(a.webContents.close).toHaveBeenCalledWith({
      waitForBeforeUnload: false,
    });
    expect(tabs.snapshot.tabs).toHaveLength(1);
    expect(tabs.snapshot.activeId).toBe('home');
  });

  it('keeps native Shell focus during keyboard-driven Tab activation', () => {
    const a = open('a');
    a.webContents.focus.mockClear();
    shell.webContents.focus.mockClear();
    tabs.activate(tabs.snapshot.activeId, 'shell');
    expect(shell.webContents.focus).toHaveBeenCalledOnce();
    expect(a.webContents.focus).not.toHaveBeenCalled();
    tabs.activate(tabs.snapshot.activeId);
    expect(a.webContents.focus).toHaveBeenCalledOnce();
  });

  it('allows shutdown to discard failed Home only after explicit confirmation and healthy saves', async () => {
    const a = open('a');
    crash(mocks.views[0]);
    const save = tabs.prepareCloseAll(true);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    finish(a);
    await expect(save).resolves.toBeUndefined();
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'warning',
        detail: expect.stringContaining('Home'),
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(tabs.snapshot.busy).toBe(true);
    expect(a.webContents.close).not.toHaveBeenCalled();
  });

  it('retains pages and resumes input when unavailable-renderer discard is cancelled', async () => {
    const a = open('a');
    crash(mocks.views[0]);
    mocks.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const save = tabs.prepareCloseAll(true);
    finish(a);
    await expect(save).rejects.toThrow('cancelled');
    expect(tabs.snapshot.busy).toBe(false);
    expect(a.webContents.close).not.toHaveBeenCalled();
    expect(a.webContents.send).toHaveBeenCalledWith('tabs:resume');
  });

  it('does not discard a healthy page whose save fails alongside failed Home', async () => {
    const a = open('a');
    crash(mocks.views[0]);
    const save = tabs.prepareCloseAll(true);
    finish(a, false);
    await expect(save).rejects.toThrow('Disk full');
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(tabs.snapshot.busy).toBe(false);
    expect(a.webContents.close).not.toHaveBeenCalled();
  });

  it('never offers to discard unavailable pages while changing Workspace', async () => {
    const a = open('a');
    const home = mocks.views[0];
    crash(home);
    const change = tabs.beginWorkspaceChange(home.webContents as never);
    finish(a);
    await expect(change).rejects.toThrow('not ready');
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(tabs.snapshot.workspaceId).toBe('workspace');
    expect(a.webContents.close).not.toHaveBeenCalled();
  });

  it('does not navigate again when activating an existing Space without a link intent', () => {
    const a = open('a');
    open('b');
    a.webContents.send.mockClear();
    tabs.open({ canvasId: 'a' });
    expect(a.webContents.send).not.toHaveBeenCalledWith(
      'tabs:navigate',
      expect.anything(),
    );
  });

  it('uses independent persistent connection pools per Space', () => {
    open('a');
    open('b');
    const a = mocks.options[1].webPreferences?.partition;
    const b = mocks.options[2].webPreferences?.partition;
    expect(a).toMatch(/^persist:huabu-space-/);
    expect(b).not.toBe(a);
    expect(mocks.options[0].webPreferences?.partition).toBeUndefined();
  });

  it('diverts native cross-Space navigation without changing the source page identity', () => {
    const a = open('a');
    const navigate = a.webContents.callbacks.get('will-navigate');
    if (!navigate) throw new Error('Missing navigation guard');
    const event = { preventDefault: vi.fn() };
    navigate(
      event as never,
      'http://localhost:3001/canvas/b?node=n#anchor' as never,
    );
    expect(event.preventDefault).toHaveBeenCalled();
    expect(tabs.snapshot.tabs.map((tab) => tab.canvasId)).toEqual([
      null,
      'a',
      'b',
    ]);
    expect(a.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(mocks.views[2].webContents.loadURL).toHaveBeenCalledWith(
      'http://localhost:3001/canvas/b?node=n#anchor',
    );
  });

  it('keeps a saved Tab alive if session persistence fails before closing', async () => {
    const a = open('a');
    const id = tabs.snapshot.activeId;
    mkdirSync(join(directory, 'desktop-tabs.json.tmp'));
    const close = tabs.close(id);
    finish(a);
    await expect(close).rejects.toThrow();
    expect(a.webContents.close).not.toHaveBeenCalled();
    expect(tabs.snapshot.activeId).toBe(id);
    expect(tabs.snapshot.tabs).toHaveLength(2);
    expect(tabs.snapshot.busy).toBe(false);
    expect(a.webContents.send).toHaveBeenCalledWith('tabs:resume');
  });

  it('preserves the active page and Tab list when activation or opening cannot persist', () => {
    open('a');
    const b = open('b');
    const before = tabs.snapshot;
    mkdirSync(join(directory, 'desktop-tabs.json.tmp'));
    expect(() => tabs.activate(before.tabs[1].id)).toThrow();
    expect(tabs.snapshot).toEqual(before);
    expect(b.setVisible).toHaveBeenLastCalledWith(true);
    expect(() => tabs.open({ canvasId: 'c' })).toThrow();
    expect(tabs.snapshot).toEqual(before);
  });

  it('bootstraps legacy metadata and synchronizes only recognized application preferences', () => {
    const home = mocks.views[0];
    tabs.storageSnapshot(home.webContents as never, {
      'huabu-chat': 'legacy',
      'huabu.language': 'en',
    });
    const a = open('a');
    const b = open('b');
    expect(
      tabs.storageSnapshot(a.webContents as never, undefined)['huabu-chat'],
    ).toBe('legacy');
    tabs.setPreference(a.webContents as never, 'huabu.language', 'zh-CN');
    expect(b.webContents.send).toHaveBeenCalledWith('tabs:preference', {
      key: 'huabu.language',
      value: 'zh-CN',
    });
    expect(
      tabs.storageSnapshot(b.webContents as never, undefined)['huabu.language'],
    ).toBe('zh-CN');
    expect(() => tabs.storageSnapshot(a.webContents as never, {})).toThrow(
      'Only Home',
    );
    expect(() =>
      tabs.setPreference(a.webContents as never, 'huabu-chat', '{}'),
    ).toThrow('Invalid');
    mkdirSync(join(directory, 'desktop-tabs.json.tmp'));
    expect(() =>
      tabs.setPreference(a.webContents as never, 'huabu.language', 'en'),
    ).toThrow();
    expect(
      tabs.storageSnapshot(b.webContents as never, undefined)['huabu.language'],
    ).toBe('zh-CN');
  });
  it('keeps the Tab and resumes input if saving fails', async () => {
    const a = open('a');
    const close = tabs.close(tabs.snapshot.activeId);
    finish(a, false);
    await expect(close).rejects.toThrow('Disk full');
    expect(a.webContents.close).not.toHaveBeenCalled();
    expect(tabs.snapshot.busy).toBe(false);
    expect(a.webContents.send).toHaveBeenCalledWith('tabs:resume');
    expect(tabs.snapshot.tabs).toHaveLength(2);
  });

  it('times out without pretending a save succeeded', async () => {
    vi.useFakeTimers();
    const a = open('a');
    const close = tabs.close(tabs.snapshot.activeId);
    const rejected = expect(close).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(a.webContents.close).not.toHaveBeenCalled();
    expect(tabs.snapshot.busy).toBe(false);
  });

  it('awaits all save acknowledgements before resuming a failed window close', async () => {
    const a = open('a');
    const b = open('b');
    const save = tabs.prepareCloseAll();
    const rejection = expect(save).rejects.toThrow('Disk full');
    finish(a, false);
    await Promise.resolve();
    expect(tabs.snapshot.busy).toBe(true);
    finish(b);
    finish(mocks.views[0]);
    await rejection;
    expect(tabs.snapshot.busy).toBe(false);
    expect(a.webContents.close).not.toHaveBeenCalled();
    expect(b.webContents.close).not.toHaveBeenCalled();
  });

  it('does not accept another renderer acknowledging a save', async () => {
    const a = open('a');
    const close = tabs.close(tabs.snapshot.activeId);
    const id = a.webContents.send.mock.calls.at(-1)![1];
    expect(() =>
      tabs.finishDrain(mocks.views[0].webContents as never, id, { ok: true }),
    ).toThrow('does not belong');
    finish(a);
    await close;
  });

  it('separates first hydration from genuine background completion', () => {
    const a = open('a');
    open('b');
    tabs.report(a.webContents as never, report({ completion: 'turn1' }));
    expect(tabs.snapshot.tabs[1].unread).toBe(false);
    tabs.report(
      a.webContents as never,
      report({ running: true, completion: '' }),
    );
    expect(tabs.snapshot.tabs[1].unread).toBe(false);
    tabs.report(a.webContents as never, report({ completion: 'turn2' }));
    expect(tabs.snapshot.tabs[1].unread).toBe(true);
    tabs.activate(tabs.snapshot.tabs[1].id);
    expect(tabs.snapshot.tabs[1].unread).toBe(false);
  });

  it('notifies renderer failure separately even when a task already reported an error', async () => {
    const a = open('a');
    tabs.report(
      a.webContents as never,
      report({ error: 'Earlier task failed' }),
    );
    const crashed = a.webContents.callbacks.get('render-process-gone');
    if (!crashed) throw new Error('Missing renderer failure handler');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      crashed({} as never, { reason: 'crashed' } as never);
      crashed({} as never, { reason: 'crashed' } as never);
      expect(mocks.showErrorBox).toHaveBeenCalledTimes(1);
      expect(mocks.showErrorBox).toHaveBeenCalledWith(
        'Space unavailable',
        expect.stringContaining('Space renderer stopped: crashed'),
      );
      await tabs.reload(tabs.snapshot.activeId);
      crashed({} as never, { reason: 'crashed' } as never);
      expect(mocks.showErrorBox).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });

  it('restores order and active Space lazily even when the local port changes', () => {
    open('a');
    open('b');
    tabs.activate(tabs.snapshot.tabs[1].id);
    tabs.dispose();
    const before = mocks.views.length;
    tabs = makeTabs('http://localhost:3009');
    tabs.ready(mocks.views[before].webContents as never);
    tabs.workspaceReady(mocks.views[before].webContents as never, 'workspace');
    expect(tabs.snapshot.tabs.map((tab) => tab.canvasId)).toEqual([
      null,
      'a',
      'b',
    ]);
    expect(
      tabs.snapshot.tabs.find((tab) => tab.id === tabs.snapshot.activeId)
        ?.canvasId,
    ).toBe('a');
    expect(mocks.views.length - before).toBe(2);
  });

  it('keeps remote Server sessions separate', () => {
    open('a');
    tabs.dispose();
    const before = mocks.views.length;
    tabs = makeTabs('https://remote.example', true);
    tabs.ready(mocks.views[before].webContents as never);
    tabs.workspaceReady(mocks.views[before].webContents as never, 'workspace');
    expect(tabs.snapshot.tabs.map((tab) => tab.canvasId)).toEqual([null]);
  });

  it('closes old pages before admitting a new Workspace', async () => {
    const a = open('a');
    const home = mocks.views[0];
    tabs.activate('home');
    const change = tabs.beginWorkspaceChange(home.webContents as never);
    expect(() => tabs.open({ canvasId: 'b' })).toThrow('saving');
    finish(home);
    finish(a);
    await change;
    expect(a.webContents.close).toHaveBeenCalled();
    expect(tabs.snapshot.workspaceId).toBeNull();
    expect(() =>
      tabs.workspaceReady(home.webContents as never, 'new-workspace'),
    ).toThrow('Finish changing Workspace');
    tabs.endWorkspaceChange(home.webContents as never);
    expect(tabs.snapshot.workspaceId).toBeNull();
    tabs.workspaceReady(home.webContents as never, 'new-workspace');
    expect(tabs.snapshot.workspaceId).toBe('new-workspace');
    expect(tabs.snapshot.tabs.map((tab) => tab.canvasId)).toEqual([null]);
    expect(
      JSON.parse(readFileSync(join(directory, 'desktop-tabs.json'), 'utf8'))[
        '["local","workspace"]'
      ].canvasIds,
    ).toEqual(['a']);
  });

  it('does not queue a stale identity for restoration if Workspace confirmation fails', async () => {
    const a = open('a');
    const home = mocks.views[0];
    const change = tabs.beginWorkspaceChange(home.webContents as never);
    finish(home);
    finish(a);
    await change;
    expect(() =>
      tabs.workspaceReady(home.webContents as never, 'workspace'),
    ).toThrow('Finish changing Workspace');
    tabs.endWorkspaceChange(home.webContents as never);
    expect(tabs.snapshot.workspaceId).toBeNull();
    expect(tabs.snapshot.tabs.map((tab) => tab.canvasId)).toEqual([null]);
  });

  it('requires Home to switch Workspaces', async () => {
    const a = open('a');
    await expect(
      tabs.beginWorkspaceChange(a.webContents as never),
    ).rejects.toThrow('from Home');
    expect(tabs.snapshot.busy).toBe(false);
  });

  it('reloads only after save acknowledgement', async () => {
    const a = open('a');
    const reload = tabs.reload(tabs.snapshot.activeId);
    expect(a.webContents.reload).not.toHaveBeenCalled();
    finish(a);
    await reload;
    expect(a.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it('asks before closing an unavailable renderer', async () => {
    const a = open('a');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    a.webContents.callbacks.get('render-process-gone')?.(
      null as never,
      { reason: 'crashed' } as never,
    );
    await tabs.close(tabs.snapshot.activeId);
    expect(mocks.showMessageBox).toHaveBeenCalled();
    expect(a.webContents.close).toHaveBeenCalled();
    log.mockRestore();
  });

  it('rejects unowned renderers and subframes at the IPC boundary', async () => {
    registerDesktopTabsIpc(() => tabs);
    const handler = mocks.handlers.get('tabs:open')!;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      handler(
        { sender: shell.webContents, senderFrame: {} } as never,
        { canvasId: 'a' } as never,
      ),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      handler(
        {
          sender: { ...shell.webContents, id: 999 },
          senderFrame: shell.webContents.mainFrame,
        } as never,
        { canvasId: 'a' } as never,
      ),
    ).resolves.toMatchObject({ ok: false });
    log.mockRestore();
    expect(tabs.snapshot.tabs).toHaveLength(1);
  });

  it('reports corrupt persisted state explicitly', () => {
    tabs.dispose();
    writeFileSync(join(directory, 'desktop-tabs.json'), 'broken');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    tabs = makeTabs();
    expect(mocks.showErrorBox).toHaveBeenCalledWith(
      'Could not restore Tabs',
      expect.any(String),
    );
    log.mockRestore();
  });
});
