// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  applicationPreferenceStorage,
  desktopSpaceStorage,
  desktopStorageKey,
  readApplicationPreference,
  subscribeApplicationPreferences,
  writeApplicationPreference,
} from './desktopStorage';

import type {
  DesktopTabContext,
  DesktopTabsApi,
} from '@huabu/shared/desktop-tabs';

let authoritative: Record<string, string>;

function setContext(context: DesktopTabContext) {
  const tabs: DesktopTabsApi = {
    context,
    storageSnapshot: vi.fn((legacy?: Record<string, string>) => {
      if (legacy) {
        for (const [key, value] of Object.entries(legacy))
          authoritative[key] ??= value;
      }
      return { ok: true as const, values: { ...authoritative } };
    }),
    setPreference: vi.fn((key: string, value: string | null) => {
      if (value === null) delete authoritative[key];
      else authoritative[key] = value;
      return { ok: true as const };
    }),
    onPreference: vi.fn(() => vi.fn()),
    getState: vi.fn(),
    onState: vi.fn(),
    open: vi.fn(),
    activate: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    command: vi.fn(),
    onHomeMenu: vi.fn(),
    ready: vi.fn(),
    report: vi.fn(),
    workspaceReady: vi.fn(),
    beginWorkspaceChange: vi.fn(),
    endWorkspaceChange: vi.fn(),
    onNavigate: vi.fn(),
    onPrepareClose: vi.fn(),
    finishPrepareClose: vi.fn(),
    onResume: vi.fn(),
  };
  window.electronBridge = {
    isElectron: true,
    isRemoteServer: false,
    platform: 'darwin',
    titleBarHeight: 36,
    versions: { electron: '43', chrome: '', node: '' },
    tabs,
  };
  return tabs;
}

beforeEach(() => {
  authoritative = {};
  localStorage.clear();
  delete window.electronBridge;
});

afterEach(() => {
  delete window.electronBridge;
  localStorage.clear();
  vi.restoreAllMocks();
});

it('keeps browser preferences persisted in localStorage', () => {
  const storage = applicationPreferenceStorage();
  storage.setItem('huabu-chat-preferences', '{"version":1}');
  expect(storage.getItem('huabu-chat-preferences')).toBe('{"version":1}');
  expect(localStorage.getItem('huabu-chat-preferences')).toBe('{"version":1}');
  storage.removeItem('huabu-chat-preferences');
  expect(storage.getItem('huabu-chat-preferences')).toBeNull();
  expect(() => storage.setItem('huabu-chat', '{}')).toThrow(
    'Unknown application preference',
  );
});

it('reads and writes desktop preferences only through main', () => {
  const tabs = setContext({ role: 'space', workspaceId: 'w', canvasId: 'a' });
  const storage = applicationPreferenceStorage();
  storage.setItem('huabu.language', 'en');
  expect(tabs.setPreference).toHaveBeenCalledWith('huabu.language', 'en');
  expect(readApplicationPreference('huabu.language')).toBe('en');
  expect(localStorage.getItem('huabu.language')).toBeNull();
  storage.removeItem('huabu.language');
  expect(storage.getItem('huabu.language')).toBeNull();
  expect(tabs.setPreference).toHaveBeenLastCalledWith('huabu.language', null);
});

it('does not commit a failed write or silently fall back to localStorage', () => {
  const tabs = setContext({ role: 'space', workspaceId: 'w', canvasId: 'a' });
  writeApplicationPreference('huabu.language', 'en');
  vi.mocked(tabs.setPreference).mockReturnValue({
    ok: false,
    error: 'Disk full',
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => writeApplicationPreference('huabu.language', 'zh-CN')).toThrow(
    'Disk full',
  );
  expect(readApplicationPreference('huabu.language')).toBe('en');
  expect(localStorage.getItem('huabu.language')).toBeNull();
});

it('reports authoritative read failures rather than using stale local values', () => {
  const tabs = setContext({ role: 'space', workspaceId: 'w', canvasId: 'a' });
  localStorage.setItem('huabu.language', 'zh-CN');
  vi.mocked(tabs.storageSnapshot).mockReturnValue({
    ok: false,
    error: 'Snapshot unavailable',
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => readApplicationPreference('huabu.language')).toThrow(
    'Snapshot unavailable',
  );
  expect(log).toHaveBeenCalledWith(
    '[desktop-tabs] Could not read preference:',
    'Snapshot unavailable',
  );
});

it.each(['shell-first', 'home-first'])(
  'preserves legacy preferences during %s startup',
  async (order) => {
    localStorage.setItem('huabu.language', 'zh-CN');
    localStorage.setItem('huabu:world-enabled', 'true');
    localStorage.setItem('huabu-chat', 'legacy metadata');
    async function start(role: 'shell' | 'home') {
      const tabs = setContext({ role, workspaceId: null, canvasId: null });
      vi.resetModules();
      await import('./desktopStorage');
      return tabs;
    }
    if (order === 'shell-first') {
      const shell = await start('shell');
      expect(shell.storageSnapshot).not.toHaveBeenCalled();
      expect(localStorage.getItem('huabu.language')).toBe('zh-CN');
    }
    const home = await start('home');
    expect(home.storageSnapshot).toHaveBeenCalledWith({
      'huabu.language': 'zh-CN',
      'huabu:world-enabled': 'true',
      'huabu-chat': 'legacy metadata',
    });
    expect(authoritative['huabu.language']).toBe('zh-CN');
    expect(localStorage.getItem('huabu.language')).toBeNull();
    expect(localStorage.getItem('huabu:world-enabled')).toBeNull();
    expect(localStorage.getItem('huabu-chat')).toBe('legacy metadata');
    if (order === 'home-first') await start('shell');
    expect(readApplicationPreference('huabu.language')).toBe('zh-CN');
  },
);

it('keeps legacy preferences intact when migration fails', async () => {
  const tabs = setContext({ role: 'home', workspaceId: null, canvasId: null });
  localStorage.setItem('huabu.language', 'zh-CN');
  vi.mocked(tabs.storageSnapshot).mockReturnValue({
    ok: false,
    error: 'Disk full',
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
  await expect(import('./desktopStorage')).rejects.toThrow('Disk full');
  expect(localStorage.getItem('huabu.language')).toBe('zh-CN');
});

it('does not restore removed preferences from a closed Space partition', async () => {
  setContext({ role: 'space', workspaceId: 'w', canvasId: 'a' });
  localStorage.setItem('huabu.language', 'zh-CN');
  localStorage.setItem('huabu-chat', 'existing metadata');
  authoritative = {
    'huabu-chat': 'older metadata',
    'huabu:world-enabled': 'true',
  };
  vi.resetModules();
  await import('./desktopStorage');
  expect(readApplicationPreference('huabu.language')).toBeNull();
  expect(readApplicationPreference('huabu:world-enabled')).toBe('true');
  expect(localStorage.getItem('huabu.language')).toBeNull();
  expect(localStorage.getItem('huabu:world-enabled')).toBeNull();
  expect(localStorage.getItem('huabu-chat')).toBe('existing metadata');
});

it('treats desktop notifications as invalidations without writing storage or echoing IPC', () => {
  const tabs = setContext({ role: 'space', workspaceId: 'w', canvasId: 'a' });
  const values: Array<string | null> = [];
  const unsubscribe = subscribeApplicationPreferences((key) =>
    values.push(readApplicationPreference(key)),
  );
  const listener = vi.mocked(tabs.onPreference).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Missing preference listener');
  writeApplicationPreference('huabu.language', 'en');
  listener({ key: 'huabu.language', value: 'zh-CN' });
  expect(values).toEqual(['en']);
  delete authoritative['huabu.language'];
  listener({ key: 'huabu.language', value: 'zh-CN' });
  expect(values).toEqual(['en', null]);
  expect(tabs.setPreference).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('huabu.language')).toBeNull();
  unsubscribe();
  expect(
    vi.mocked(tabs.onPreference).mock.results[0].value,
  ).toHaveBeenCalledOnce();
});

it('subscribes to browser storage changes and removes its listener', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeApplicationPreferences(listener);
  window.dispatchEvent(
    new StorageEvent('storage', { key: 'huabu.language', newValue: 'en' }),
  );
  window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
  expect(listener).toHaveBeenCalledExactlyOnceWith('huabu.language');
  unsubscribe();
  window.dispatchEvent(new StorageEvent('storage', { key: 'huabu.language' }));
  expect(listener).toHaveBeenCalledOnce();
});

it('hydrates desktop language in memory without i18next localStorage caching', async () => {
  const tabs = setContext({ role: 'space', workspaceId: 'w', canvasId: 'a' });
  authoritative['huabu.language'] = 'zh-CN';
  localStorage.setItem('huabu.language', 'en');
  vi.resetModules();
  const { i18n } = await import('../i18n');
  await vi.waitFor(() => expect(i18n.language).toBe('zh-CN'));
  expect(localStorage.getItem('huabu.language')).toBeNull();
  const listener = vi.mocked(tabs.onPreference).mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Missing language subscription');
  authoritative['huabu.language'] = 'en';
  listener({ key: 'huabu.language', value: 'zh-CN' });
  await vi.waitFor(() => expect(i18n.language).toBe('en'));
  expect(localStorage.getItem('huabu.language')).toBeNull();
  expect(tabs.setPreference).not.toHaveBeenCalled();
});

it('preserves browser keys and isolates Space metadata without changing sibling records', () => {
  const storage = desktopSpaceStorage();
  localStorage.setItem('huabu-chat', 'legacy');
  expect(desktopStorageKey('huabu-chat')).toBe('huabu-chat');
  setContext({ role: 'home', workspaceId: null, canvasId: null });
  expect(desktopStorageKey('huabu-chat')).toBe('huabu-chat');
  setContext({ role: 'space', workspaceId: 'w1', canvasId: 'a' });
  expect(storage.getItem('huabu-chat')).toBe('legacy');
  storage.setItem('huabu-chat', 'a metadata');
  setContext({ role: 'space', workspaceId: 'w1', canvasId: 'b' });
  expect(storage.getItem('huabu-chat')).toBe('legacy');
  storage.setItem('huabu-chat', 'b metadata');
  storage.removeItem('huabu-chat');
  setContext({ role: 'space', workspaceId: 'w1', canvasId: 'a' });
  expect(storage.getItem('huabu-chat')).toBe('a metadata');
  expect(localStorage.getItem('huabu-chat')).toBe('legacy');
  setContext({ role: 'space', workspaceId: 'w2', canvasId: 'a' });
  expect(storage.getItem('huabu-chat')).toBe('legacy');
});
