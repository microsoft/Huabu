// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as Toast from '@/components/Common/Toast';
import useCanvasStore from '@/store/canvasStore';
import { useChatPreferencesStore } from '@/store/chatPreferencesStore';
import { useToolStore } from '@/store/toolStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { useDesktopContent } from './useDesktopContent';

import type {
  DesktopPreferenceChange,
  DesktopPreferenceKey,
  DesktopTabsApi,
} from '@huabu/shared/desktop-tabs';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let values: Partial<Record<DesktopPreferenceKey, string>>;
let tabs: DesktopTabsApi;
let listeners: Set<(change: DesktopPreferenceChange) => void>;

function Harness() {
  useDesktopContent();
  return null;
}

function currentPreferences() {
  return {
    input: useToolStore.getState().inputModePreference,
    turns: useChatPreferencesStore.getState().recentTurnCount,
    world: useWorkspaceStore.getState().worldEnabled,
    minimap: useCanvasStore.getState().minimapEnabled,
  };
}

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>,
    );
  });
}

function emit(key: DesktopPreferenceKey) {
  for (const listener of listeners)
    listener({ key, value: values[key] ?? null });
}

beforeEach(async () => {
  delete window.electronBridge;
  localStorage.clear();
  await useToolStore.persist.rehydrate();
  await useChatPreferencesStore.persist.rehydrate();
  useToolStore.getState().setPendingNodeType('note');
  useWorkspaceStore.setState({ worldEnabled: false, isReady: false });
  useCanvasStore.setState({ minimapEnabled: false, canvasId: '' });
  values = {};
  listeners = new Set();
  tabs = {
    context: { role: 'space', workspaceId: 'workspace', canvasId: 'space-a' },
    getPreference: vi.fn<DesktopTabsApi['getPreference']>((key) => {
      expect(listeners.size).toBe(1);
      return { ok: true as const, value: values[key] ?? null };
    }),
    storageSnapshot: vi.fn(),
    setPreference: vi.fn(),
    onPreference: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getState: vi.fn().mockResolvedValue({
      tabs: [],
      activeId: 'home',
      workspaceId: 'workspace',
      busy: false,
    }),
    onState: vi.fn(() => vi.fn()),
    open: vi.fn(),
    activate: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    command: vi.fn().mockResolvedValue({ ok: true }),
    onHomeMenu: vi.fn(),
    ready: vi.fn(),
    report: vi.fn(),
    workspaceReady: vi.fn(),
    beginWorkspaceChange: vi.fn(),
    endWorkspaceChange: vi.fn(),
    onNavigate: vi.fn(() => vi.fn()),
    onPrepareClose: vi.fn(() => vi.fn()),
    finishPrepareClose: vi.fn(),
    keepPrepareCloseAlive: vi.fn(),
    onClosePrepared: vi.fn(() => vi.fn()),
    onResume: vi.fn(() => vi.fn()),
  };
  window.electronBridge = {
    isElectron: true,
    isRemoteServer: false,
    platform: 'darwin',
    titleBarHeight: 36,
    versions: { electron: '43', chrome: '', node: '' },
    tabs,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  expect(listeners.size).toBe(0);
  container.remove();
  delete window.electronBridge;
  localStorage.clear();
  vi.restoreAllMocks();
});

it.each(['home', 'space'] as const)(
  'reconciles all four preferences changed before %s mounts, without writing',
  async (role) => {
    tabs.context.role = role;
    expect(currentPreferences()).toEqual({
      input: 'auto',
      turns: 3,
      world: false,
      minimap: false,
    });
    values = {
      'huabu-sketch-tools': JSON.stringify({
        state: { inputModePreference: 'finger' },
        version: 3,
      }),
      'huabu-chat-preferences': JSON.stringify({
        state: { recentTurnCount: 7 },
        version: 1,
      }),
      'huabu:world-enabled': 'true',
      'huabu.minimapEnabled': 'true',
    };
    for (const key of Object.keys(values) as DesktopPreferenceKey[]) emit(key);
    expect(listeners.size).toBe(0);
    await render();
    expect(currentPreferences()).toEqual({
      input: 'finger',
      turns: 7,
      world: true,
      minimap: true,
    });
    expect(useToolStore.getState().pendingNodeType).toBe('note');
    expect(tabs.getPreference).toHaveBeenCalledTimes(4);
    expect(tabs.storageSnapshot).not.toHaveBeenCalled();
    expect(tabs.setPreference).not.toHaveBeenCalled();
    await act(async () => {
      values['huabu.minimapEnabled'] = 'false';
      emit('huabu.minimapEnabled');
    });
    expect(useCanvasStore.getState().minimapEnabled).toBe(false);
  },
);

it('reconciles preferences deleted before mount without restoring stale local replicas', async () => {
  delete window.electronBridge;
  useToolStore.getState().setInputModePreference('finger');
  useChatPreferencesStore.getState().setRecentTurnCount(7);
  useWorkspaceStore.setState({ worldEnabled: true });
  useCanvasStore.setState({ minimapEnabled: true });
  window.electronBridge = {
    isElectron: true,
    isRemoteServer: false,
    platform: 'darwin',
    titleBarHeight: 36,
    versions: { electron: '43', chrome: '', node: '' },
    tabs,
  };
  await render();
  expect(currentPreferences()).toEqual({
    input: 'auto',
    turns: 3,
    world: false,
    minimap: false,
  });

  expect(useToolStore.getState().pendingNodeType).toBe('note');
  expect(tabs.setPreference).not.toHaveBeenCalled();
});

it('publishes live Workspace switching capabilities from Home only', async () => {
  tabs.context.role = 'home';
  useWorkspaceStore.setState({
    capabilities: { canChangeWorkspace: false, nativePicker: false },
  });
  await render();
  expect(tabs.command).toHaveBeenLastCalledWith({
    type: 'sync-workspace-capabilities',
    canChangeWorkspace: false,
  });
  await act(async () => {
    useWorkspaceStore.setState({
      capabilities: { canChangeWorkspace: true, nativePicker: true },
    });
  });
  expect(tabs.command).toHaveBeenLastCalledWith({
    type: 'sync-workspace-capabilities',
    canChangeWorkspace: true,
  });
});

it('reports an initial read failure while retaining the subscription for recovery', async () => {
  const read = vi.mocked(tabs.getPreference);
  const implementation = read.getMockImplementation();
  if (!implementation) throw new Error('Missing preference reader');
  read.mockImplementation((key) =>
    key === 'huabu:world-enabled'
      ? { ok: false, error: 'Preferences unavailable' }
      : implementation(key),
  );
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const toast = vi.spyOn(Toast, 'toast').mockReturnValue('test-error');
  values['huabu:world-enabled'] = 'true';
  await render();
  expect(useWorkspaceStore.getState().worldEnabled).toBe(false);
  expect(log).toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith('Preferences unavailable', {
    tone: 'danger',
  });
  read.mockImplementation(implementation);
  await act(async () => emit('huabu:world-enabled'));
  expect(useWorkspaceStore.getState().worldEnabled).toBe(true);
  expect(tabs.setPreference).not.toHaveBeenCalled();
});

it('does not reconcile desktop preferences in a browser', async () => {
  delete window.electronBridge;
  const before = currentPreferences();
  await render();
  expect(currentPreferences()).toEqual(before);
  expect(tabs.onPreference).not.toHaveBeenCalled();
  expect(tabs.getPreference).not.toHaveBeenCalled();
});
