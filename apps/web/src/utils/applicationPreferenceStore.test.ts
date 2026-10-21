// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { toast } from '@/components/Common/Toast';
import useCanvasStore from '@/store/canvasStore';
import { useChatPreferencesStore } from '@/store/chatPreferencesStore';
import { useToolStore } from '@/store/toolStore';

import type {
  DesktopPreferenceKey,
  DesktopTabsApi,
} from '@huabu/shared/desktop-tabs';

vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));

let values: Record<string, string>;
const write = vi.fn<DesktopTabsApi['setPreference']>();

beforeEach(async () => {
  values = {};
  vi.clearAllMocks();
  write.mockImplementation((key, value, expectedValue) => {
    if (expectedValue !== undefined && (values[key] ?? null) !== expectedValue)
      return {
        ok: false,
        error: 'Preferences changed in another Tab. Please try again.',
      };
    if (value === null) delete values[key];
    else values[key] = value;
    return { ok: true };
  });
  window.electronBridge = {
    isElectron: true,
    isRemoteServer: false,
    platform: 'darwin',
    titleBarHeight: 36,
    versions: { electron: '43', chrome: '', node: '' },
    tabs: {
      context: { role: 'space', workspaceId: 'w', canvasId: 'a' },
      getPreference: vi.fn<DesktopTabsApi['getPreference']>((key) => ({
        ok: true,
        value: values[key] ?? null,
      })),
      storageSnapshot: vi.fn<DesktopTabsApi['storageSnapshot']>(() => ({
        ok: true,
        values: { ...values },
      })),
      setPreference: write,
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
    },
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await useToolStore.persist.rehydrate();
  await useChatPreferencesStore.persist.rehydrate();
  write.mockClear();
});

afterEach(() => {
  delete window.electronBridge;
  localStorage.clear();
  vi.restoreAllMocks();
});

it('does not publish input preference changes when main persistence fails', () => {
  const before = useToolStore.getState();
  const listener = vi.fn();
  const unsubscribe = useToolStore.subscribe(listener);
  try {
    write.mockReturnValue({ ok: false, error: 'Disk full' });
    expect(() =>
      useToolStore.getState().setInputModePreference('finger'),
    ).toThrow('Disk full');
    expect(useToolStore.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Disk full', { tone: 'danger' });
  } finally {
    unsubscribe();
  }
});

it('does not publish chat preference changes when main persistence fails', () => {
  const before = useChatPreferencesStore.getState();
  write.mockReturnValue({ ok: false, error: 'Disk full' });
  expect(() =>
    useChatPreferencesStore.getState().setRecentTurnCount(7),
  ).toThrow('Disk full');
  expect(useChatPreferencesStore.getState()).toBe(before);
  expect(toast).toHaveBeenCalledWith('Disk full', { tone: 'danger' });
});

it('also protects imperative setState calls', () => {
  const before = useToolStore.getState();
  write.mockReturnValue({ ok: false, error: 'Disk full' });
  expect(() =>
    useToolStore.setState({ inputModePreference: 'finger' }),
  ).toThrow('Disk full');
  expect(useToolStore.getState()).toBe(before);
});

function tools(state: Record<string, unknown>): void {
  values['huabu-sketch-tools'] = JSON.stringify({ state, version: 3 });
}

function persisted(key: DesktopPreferenceKey): Record<string, unknown> {
  return JSON.parse(values[key]).state;
}

it('does not persist transient selection or overwrite a newer preference before invalidation arrives', () => {
  tools({ inputModePreference: 'pen' });
  useToolStore.getState().setPendingNodeType('note');
  expect(write).not.toHaveBeenCalled();
  expect(persisted('huabu-sketch-tools').inputModePreference).toBe('pen');
  expect(useToolStore.getState().inputModePreference).toBe('pen');
  expect(useToolStore.getState().pendingNodeType).toBe('note');
});

it('applies a genuine preference edit to the latest main snapshot, not the stale renderer snapshot', () => {
  tools({ inputModePreference: 'pen', colorPresets: ['green', 'red', 'blue'] });
  useToolStore.getState().updateSketchColorPreset(1, 'yellow');
  expect(persisted('huabu-sketch-tools')).toMatchObject({
    inputModePreference: 'pen',
    colorPresets: ['green', 'yellow', 'blue'],
  });
  expect(write).toHaveBeenCalledTimes(1);
  expect(useToolStore.getState().colorPresets).toEqual([
    'green',
    'yellow',
    'blue',
  ]);
  expect(localStorage.getItem('huabu-sketch-tools')).toBeNull();
});

it('does not overwrite a competing write between reading and committing', () => {
  const before = useToolStore.getState();
  write.mockImplementation((key, _value, expectedValue) => {
    expect(expectedValue).toBeNull();
    tools({ inputModePreference: 'pen' });
    expect(key).toBe('huabu-sketch-tools');
    return {
      ok: false,
      error: 'Preferences changed in another Tab. Please try again.',
    };
  });
  expect(() =>
    useToolStore.getState().setInputModePreference('finger'),
  ).toThrow('changed in another Tab');
  expect(useToolStore.getState()).toBe(before);
  expect(persisted('huabu-sketch-tools').inputModePreference).toBe('pen');
  expect(toast).toHaveBeenCalledWith(
    'Preferences changed in another Tab. Please try again.',
    { tone: 'danger' },
  );
});

it('persists before notifying subscribers', () => {
  const unsubscribe = useChatPreferencesStore.subscribe((state) => {
    expect(persisted('huabu-chat-preferences').recentTurnCount).toBe(
      state.recentTurnCount,
    );
  });
  try {
    useChatPreferencesStore.getState().setRecentTurnCount(7);
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});

it('can change transient tool state without writing to a full disk', () => {
  write.mockReturnValue({ ok: false, error: 'Disk full' });
  useToolStore.getState().setPendingNodeType('frame');
  useToolStore.getState().resetForCanvasSwitch();
  expect(useToolStore.getState().pendingNodeType).toBeNull();
  expect(write).not.toHaveBeenCalled();
});

it('does not read or persist preferences on repeated known pen input', () => {
  useToolStore.getState().observePen();
  const tabs = window.electronBridge?.tabs;
  if (!tabs) throw new Error('Missing desktop bridge');
  const read = vi.spyOn(tabs, 'getPreference').mockClear();
  write.mockClear();
  for (let stroke = 0; stroke < 100; stroke++) {
    useToolStore.getState().observePen();
  }
  expect(read).not.toHaveBeenCalled();
  expect(tabs.storageSnapshot).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it('preserves transient state when incoming preferences are deleted', async () => {
  useToolStore.getState().setPendingNodeType('note');
  useToolStore.getState().setInputModePreference('finger');
  delete values['huabu-sketch-tools'];
  write.mockClear();
  await useToolStore.persist.rehydrate();
  expect(useToolStore.getState().pendingNodeType).toBe('note');
  expect(useToolStore.getState().inputModePreference).toBe('auto');
  expect(write).not.toHaveBeenCalled();
});

it('rejects malformed authoritative storage without changing memory', () => {
  values['huabu-sketch-tools'] = 'invalid JSON';
  const before = useToolStore.getState();
  expect(() =>
    useToolStore.getState().setInputModePreference('finger'),
  ).toThrow();
  expect(useToolStore.getState()).toBe(before);
  expect(write).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalled();
});

it('keeps MiniMap unchanged and surfaces a desktop write failure', () => {
  const before = useCanvasStore.getState().minimapEnabled;
  write.mockReturnValue({ ok: false, error: 'Disk full' });
  expect(() => useCanvasStore.getState().toggleMinimap()).toThrow('Disk full');
  expect(useCanvasStore.getState().minimapEnabled).toBe(before);
  expect(toast).toHaveBeenCalledWith('Disk full', { tone: 'danger' });
});

it('retains the browser MiniMap in-memory fallback when localStorage is unavailable', () => {
  delete window.electronBridge;
  const before = useCanvasStore.getState().minimapEnabled;
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  useCanvasStore.getState().toggleMinimap();
  expect(useCanvasStore.getState().minimapEnabled).toBe(!before);
  expect(toast).toHaveBeenCalledWith('Storage unavailable', { tone: 'danger' });
});
