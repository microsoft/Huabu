// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applicationPreferenceStorage,
  desktopSpaceStorage,
  desktopStorageKey,
  writeApplicationPreference,
} from './desktopStorage';

import type { DesktopTabContext } from '@huabu/shared/desktop-tabs';

function setContext(context: DesktopTabContext): void {
  window.electronBridge = {
    isElectron: true,
    isRemoteServer: false,
    platform: 'darwin',
    titleBarHeight: 36,
    versions: { electron: '43', chrome: '', node: '' },
    tabs: {
      context,
      storageSnapshot: vi.fn(() => ({ ok: true as const, values: {} })),
      setPreference: vi.fn(() => ({ ok: true as const })),
      onPreference: vi.fn(),
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
    },
  };
}

describe('desktop Space storage isolation', () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.electronBridge;
  });
  afterEach(() => {
    delete window.electronBridge;
    localStorage.clear();
  });

  it('preserves browser storage keys and Home compatibility', () => {
    expect(desktopStorageKey('huabu-chat')).toBe('huabu-chat');
    setContext({ role: 'home', workspaceId: null, canvasId: null });
    expect(desktopStorageKey('huabu-chat')).toBe('huabu-chat');
  });

  it('writes browser preferences through the same canonical adapter', () => {
    const storage = applicationPreferenceStorage();
    storage.setItem('huabu-chat-preferences', '{"version":1}');
    expect(storage.getItem('huabu-chat-preferences')).toBe('{"version":1}');
    storage.removeItem('huabu-chat-preferences');
    expect(storage.getItem('huabu-chat-preferences')).toBeNull();
    expect(() => storage.setItem('huabu-chat', '{}')).toThrow(
      'Unknown application preference',
    );
  });

  it('acknowledges desktop persistence before changing local preferences', () => {
    setContext({ role: 'space', workspaceId: 'w', canvasId: 'a' });
    const tabs = window.electronBridge?.tabs;
    if (!tabs) throw new Error('Missing test bridge');
    writeApplicationPreference('huabu.language', 'en');
    expect(tabs.setPreference).toHaveBeenCalledWith('huabu.language', 'en');
    vi.mocked(tabs.setPreference).mockReturnValue({
      ok: false,
      error: 'Disk full',
    });
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    expect(() => writeApplicationPreference('huabu.language', 'zh-CN')).toThrow(
      'Disk full',
    );
    expect(localStorage.getItem('huabu.language')).toBe('en');
    error.mockRestore();
  });

  it('does not echo Shell language hydration through the content-only preference writer', () => {
    setContext({ role: 'shell', workspaceId: null, canvasId: null });
    writeApplicationPreference('huabu.language', 'en');
    expect(window.electronBridge?.tabs?.setPreference).not.toHaveBeenCalled();
    expect(localStorage.getItem('huabu.language')).toBe('en');
  });

  it('bootstraps preferences before hydration and reuses storage events for IPC changes', async () => {
    setContext({ role: 'space', workspaceId: 'w', canvasId: 'a' });
    const tabs = window.electronBridge?.tabs;
    if (!tabs) throw new Error('Missing test bridge');
    localStorage.setItem('huabu-chat', 'existing');
    vi.mocked(tabs.storageSnapshot).mockReturnValue({
      ok: true,
      values: { 'huabu-chat': 'legacy', 'huabu.language': 'zh-CN' },
    });
    vi.resetModules();
    await import('./desktopStorage');
    expect(localStorage.getItem('huabu-chat')).toBe('existing');
    expect(localStorage.getItem('huabu.language')).toBe('zh-CN');
    const listener = vi.mocked(tabs.onPreference).mock.calls.at(-1)?.[0];
    if (!listener) throw new Error('Missing preference listener');
    const storageEvent = vi.fn();
    window.addEventListener('storage', storageEvent, { once: true });
    vi.mocked(tabs.storageSnapshot).mockReturnValue({
      ok: true,
      values: { 'huabu.language': 'en' },
    });
    listener({ key: 'huabu.language', value: 'en' });
    expect(localStorage.getItem('huabu.language')).toBe('en');
    expect(storageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'huabu.language',
        oldValue: 'zh-CN',
        newValue: 'en',
      }),
    );
  });

  it.each(['huabu.language', 'huabu-sketch-tools'] as const)(
    'does not overwrite a newer local write with a queued old notification (%s)',
    async (key) => {
      setContext({ role: 'space', workspaceId: 'w', canvasId: 'b' });
      const tabs = window.electronBridge?.tabs;
      if (!tabs) throw new Error('Missing test bridge');
      vi.resetModules();
      const storage = await import('./desktopStorage');
      storage.writeApplicationPreference(key, 'new');
      vi.mocked(tabs.storageSnapshot).mockReturnValue({
        ok: true,
        values: { [key]: 'new' },
      });
      const listener = vi.mocked(tabs.onPreference).mock.calls.at(-1)?.[0];
      if (!listener) throw new Error('Missing preference listener');
      const storageEvent = vi.fn();
      window.addEventListener('storage', storageEvent);
      try {
        listener({ key, value: 'old' });
        expect(localStorage.getItem(key)).toBe('new');
        expect(storageEvent).not.toHaveBeenCalled();
        expect(tabs.setPreference).toHaveBeenCalledExactlyOnceWith(key, 'new');
        expect(tabs.storageSnapshot).toHaveBeenLastCalledWith();
      } finally {
        window.removeEventListener('storage', storageEvent);
      }
    },
  );

  it('reads current deletions instead of restoring a queued old value', async () => {
    setContext({ role: 'space', workspaceId: 'w', canvasId: 'b' });
    const tabs = window.electronBridge?.tabs;
    if (!tabs) throw new Error('Missing test bridge');
    vi.mocked(tabs.storageSnapshot).mockReturnValueOnce({
      ok: true,
      values: { 'huabu.language': 'zh-CN' },
    });
    vi.resetModules();
    await import('./desktopStorage');
    const listener = vi.mocked(tabs.onPreference).mock.calls.at(-1)?.[0];
    if (!listener) throw new Error('Missing preference listener');
    const storageEvent = vi.fn();
    window.addEventListener('storage', storageEvent, { once: true });
    listener({ key: 'huabu.language', value: 'zh-CN' });
    expect(localStorage.getItem('huabu.language')).toBeNull();
    expect(storageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'huabu.language',
        oldValue: 'zh-CN',
        newValue: null,
      }),
    );
    expect(tabs.setPreference).not.toHaveBeenCalled();
  });

  it('reports refresh failures without applying the notification value', async () => {
    setContext({ role: 'space', workspaceId: 'w', canvasId: 'b' });
    const tabs = window.electronBridge?.tabs;
    if (!tabs) throw new Error('Missing test bridge');
    vi.resetModules();
    await import('./desktopStorage');
    localStorage.setItem('huabu.language', 'en');
    vi.mocked(tabs.storageSnapshot).mockReturnValue({
      ok: false,
      error: 'Snapshot unavailable',
    });
    const listener = vi.mocked(tabs.onPreference).mock.calls.at(-1)?.[0];
    if (!listener) throw new Error('Missing preference listener');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => listener({ key: 'huabu.language', value: 'zh-CN' })).toThrow(
        'Snapshot unavailable',
      );
      expect(localStorage.getItem('huabu.language')).toBe('en');
      expect(log).toHaveBeenCalledWith(
        '[desktop-tabs] Could not refresh preference:',
        'Snapshot unavailable',
      );
    } finally {
      log.mockRestore();
    }
  });

  it('migrates legacy metadata without overwriting shared or sibling records', () => {
    const storage = desktopSpaceStorage();
    localStorage.setItem('huabu-chat', 'legacy');
    setContext({ role: 'space', workspaceId: 'w1', canvasId: 'a' });
    expect(storage.getItem('huabu-chat')).toBe('legacy');
    storage.setItem('huabu-chat', 'a metadata');
    setContext({ role: 'space', workspaceId: 'w1', canvasId: 'b' });
    expect(storage.getItem('huabu-chat')).toBe('legacy');
    storage.setItem('huabu-chat', 'b metadata');
    setContext({ role: 'space', workspaceId: 'w1', canvasId: 'a' });
    expect(storage.getItem('huabu-chat')).toBe('a metadata');
    expect(localStorage.getItem('huabu-chat')).toBe('legacy');
    setContext({ role: 'space', workspaceId: 'w2', canvasId: 'a' });
    expect(storage.getItem('huabu-chat')).toBe('legacy');
  });

  it('clears deleted preferences from a reopened Space partition without deleting Space metadata', async () => {
    setContext({ role: 'space', workspaceId: 'w', canvasId: 'a' });
    localStorage.setItem('huabu.language', 'zh-CN');
    localStorage.setItem('huabu:world-enabled', 'true');
    localStorage.setItem('huabu-sketch-tools', 'stale tools');
    localStorage.setItem('huabu-chat', 'Space metadata');
    const tabs = window.electronBridge?.tabs;
    if (!tabs) throw new Error('Missing test bridge');
    vi.mocked(tabs.storageSnapshot).mockReturnValue({
      ok: true,
      values: { 'huabu.language': 'en' },
    });
    vi.resetModules();
    await import('./desktopStorage');
    expect(localStorage.getItem('huabu.language')).toBe('en');
    expect(localStorage.getItem('huabu:world-enabled')).toBeNull();
    expect(localStorage.getItem('huabu-sketch-tools')).toBeNull();
    expect(localStorage.getItem('huabu-chat')).toBe('Space metadata');
    expect(tabs.setPreference).not.toHaveBeenCalled();
  });

  it('keeps Home legacy preference migration before applying the authoritative snapshot', async () => {
    setContext({ role: 'home', workspaceId: null, canvasId: null });
    localStorage.setItem('huabu.language', 'zh-CN');
    const tabs = window.electronBridge?.tabs;
    if (!tabs) throw new Error('Missing test bridge');
    vi.mocked(tabs.storageSnapshot).mockReturnValue({
      ok: true,
      values: { 'huabu.language': 'zh-CN' },
    });
    vi.resetModules();
    await import('./desktopStorage');
    expect(tabs.storageSnapshot).toHaveBeenCalledWith({
      'huabu.language': 'zh-CN',
    });
    expect(localStorage.getItem('huabu.language')).toBe('zh-CN');
  });

  it('deletes only the addressed Space record', () => {
    const storage = desktopSpaceStorage();
    localStorage.setItem('huabu-panel', 'legacy');
    setContext({ role: 'space', workspaceId: 'w', canvasId: 'a' });
    storage.setItem('huabu-panel', 'a');
    setContext({ role: 'space', workspaceId: 'w', canvasId: 'b' });
    storage.setItem('huabu-panel', 'b');
    storage.removeItem('huabu-panel');
    setContext({ role: 'space', workspaceId: 'w', canvasId: 'a' });
    expect(storage.getItem('huabu-panel')).toBe('a');
    expect(localStorage.getItem('huabu-panel')).toBe('legacy');
  });
});
