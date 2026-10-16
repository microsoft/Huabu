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
