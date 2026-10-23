// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getElectronBridge,
  type ElectronLocalAgentState,
} from '@/hooks/useElectron';

import { ConnectedDevicesSetting } from './ConnectedDevicesSetting';

import type { ConnectedAgentletDevice } from '@/api/acp';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useElectron', () => ({ getElectronBridge: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn(async () => undefined));
let connectedDevices: ConnectedAgentletDevice[] = [];
vi.mock('@/store/acpProfilesStore', () => ({
  useAcpProfilesStore: (
    selector: (state: {
      refresh: typeof refresh;
      connectedDevices: ConnectedAgentletDevice[];
    }) => unknown,
  ) => selector({ refresh, connectedDevices }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let onState: ((state: ElectronLocalAgentState) => void) | undefined;
const initial: ElectronLocalAgentState = {
  enabled: false,
  status: 'disabled',
  error: null,
};
const api = {
  getState: vi.fn(async () => initial),
  setEnabled: vi.fn(
    async (): Promise<ElectronLocalAgentState> => ({
      enabled: true,
      status: 'connecting',
      error: null,
    }),
  ),
  onState: vi.fn((callback: (state: ElectronLocalAgentState) => void) => {
    onState = callback;
    return vi.fn();
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  connectedDevices = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(getElectronBridge).mockReturnValue({
    isElectron: true,
    isRemoteServer: true,
    platform: 'darwin',
    titleBarHeight: 36,
    versions: { node: '', chrome: '', electron: '' },
    localAgent: api,
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('connected device settings', () => {
  it('does not expose local actions in a browser', async () => {
    vi.mocked(getElectronBridge).mockReturnValue(null);
    await act(async () => root.render(<ConnectedDevicesSetting />));
    expect(container.textContent).toBe('settings.noConnectedDevices');
    expect(container.querySelector('button')).toBeNull();
    expect(api.getState).not.toHaveBeenCalled();
  });

  it('shows a compact device connection row without explanatory copy', async () => {
    await act(async () => root.render(<ConnectedDevicesSetting />));
    expect(container.textContent).toContain('settings.localAgentTitle');
    expect(container.textContent).not.toContain(
      'settings.localAgentDescription',
    );
    expect(container.querySelector('.setting-row')?.classList).not.toContain(
      'flex-col',
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('button')?.textContent).toBe(
      'settings.localAgentConnect',
    );
  });

  it('shows the actual device name, version and ID before connecting', async () => {
    await act(async () => root.render(<ConnectedDevicesSetting />));
    await act(async () =>
      onState?.({
        enabled: false,
        status: 'disabled',
        error: null,
        device: {
          agentletId: 'this-device',
          displayName: 'My computer: darwin arm64',
          version: '2.3.4',
        },
      }),
    );
    const row = container.querySelector('.setting-row');
    expect(row?.textContent).toContain('My computer: darwin arm64');
    expect(row?.textContent).toContain('settings.localAgentThisDevice');
    expect(row?.textContent).toContain('this-device');
    expect(row?.querySelector('p + p')?.textContent).toBe(
      'v2.3.4 · this-device',
    );
    expect(row?.querySelector('button')?.textContent).toBe(
      'settings.localAgentConnect',
    );
    expect(api.setEnabled).not.toHaveBeenCalled();
  });

  it('connects without a token input and updates independently from Settings actions', async () => {
    await act(async () => root.render(<ConnectedDevicesSetting />));
    expect(container.querySelector('input')).toBeNull();
    await act(async () => container.querySelector('button')?.click());
    expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(container.textContent).toContain('settings.localAgentConnecting');
    await act(async () =>
      onState?.({ enabled: true, status: 'connected', error: null }),
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain('settings.localAgentDisconnect');
    await act(async () => container.querySelector('button')?.click());
    expect(api.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it('shows authorization failure with reconnect and disconnect controls', async () => {
    await act(async () => root.render(<ConnectedDevicesSetting />));
    await act(async () =>
      onState?.({
        enabled: true,
        status: 'authorization-required',
        error: 'Authorization rejected',
      }),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Authorization rejected',
    );
    expect(container.textContent).toContain('settings.localAgentReconnect');
    expect(container.textContent).toContain('settings.localAgentDisconnect');
  });

  it('surfaces IPC failures and leaves the action available for retry', async () => {
    api.setEnabled.mockRejectedValueOnce(new Error('Connection unavailable'));
    await act(async () => root.render(<ConnectedDevicesSetting />));
    await act(async () => container.querySelector('button')?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Connection unavailable',
    );
    expect(container.querySelector('button')?.disabled).toBe(false);
  });

  it('merges desktop controls into the exact device row, not a matching hostname', async () => {
    const device: ConnectedAgentletDevice = {
      agentletId: 'this-device',
      displayName: 'My computer: darwin arm64',
      hostname: 'My computer',
      platform: 'darwin',
      arch: 'arm64',
      version: '1.0.0',
      connectedAt: '2026-01-01T00:00:00.000Z',
      profileCount: 2,
    };
    connectedDevices = [{ ...device, agentletId: 'another-device' }, device];
    await act(async () => root.render(<ConnectedDevicesSetting />));
    await act(async () =>
      onState?.({
        enabled: true,
        status: 'connected',
        error: null,
        agentletId: 'this-device',
      }),
    );
    const rows = container.querySelectorAll('.setting-row');
    expect(rows).toHaveLength(2);
    expect(container.textContent).not.toContain('settings.localAgentTitle');
    expect(rows[0].textContent).toContain('this-device');
    expect(rows[0].textContent).toContain('settings.localAgentThisDevice');
    expect(rows[1].textContent).not.toContain('settings.localAgentThisDevice');
    expect(connectedDevices[0].agentletId).toBe('another-device');
    expect(rows[0].querySelector('p + p')?.textContent).toBe(
      'settings.deviceProfileCount · v1.0.0 · this-device',
    );
    expect(
      rows[0].querySelector('.setting-row-control')?.textContent,
    ).not.toContain('1.0.0');
    expect(rows[0].querySelector('[role="status"]')).toBeNull();
    expect(rows[0].querySelector('button')?.textContent).toBe(
      'settings.localAgentDisconnect',
    );
    expect(rows[1].querySelector('button')).toBeNull();
    await act(async () => rows[0].querySelector('button')?.click());
    expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('keeps reconnect controls available when the device disappears from the server list', async () => {
    await act(async () => root.render(<ConnectedDevicesSetting />));
    await act(async () =>
      onState?.({
        enabled: true,
        status: 'reconnecting',
        agentletId: 'this-device',
        error: null,
      }),
    );
    expect(container.querySelectorAll('.setting-row')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'settings.localAgentReconnecting',
    );
    expect(container.querySelector('button')?.textContent).toBe(
      'settings.localAgentDisconnect',
    );
  });

  it('shows server devices in a browser without desktop connection controls', async () => {
    vi.mocked(getElectronBridge).mockReturnValue(null);
    connectedDevices = [
      {
        agentletId: 'server-device',
        displayName: 'Server: linux x64',
        version: '1.0.0',
        connectedAt: '2026-01-01T00:00:00.000Z',
        profileCount: 1,
      },
    ];
    await act(async () => root.render(<ConnectedDevicesSetting />));
    expect(container.querySelectorAll('.setting-row')).toHaveLength(1);
    expect(container.textContent).toContain('Server: linux x64');
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps the connect-this-device entry first before and after connecting', async () => {
    connectedDevices = [
      {
        agentletId: 'server-device',
        displayName: 'Server: linux x64',
        version: '1.0.0',
        connectedAt: '2026-01-01T00:00:00.000Z',
        profileCount: 1,
      },
    ];
    await act(async () => root.render(<ConnectedDevicesSetting />));
    const rows = container.querySelectorAll('.setting-row');
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain('Server: linux x64');
    expect(rows[1].querySelector('button')).toBeNull();
    expect(rows[0].textContent).toContain('settings.localAgentTitle');
    expect(rows[0].querySelector('button')?.textContent).toBe(
      'settings.localAgentConnect',
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    connectedDevices = [
      ...connectedDevices,
      {
        agentletId: 'this-device',
        displayName: 'My computer',
        version: '1.0.0',
        connectedAt: '2026-01-01T00:00:00.000Z',
        profileCount: 2,
      },
    ];
    await act(async () =>
      onState?.({
        enabled: true,
        status: 'connected',
        error: null,
        agentletId: 'this-device',
      }),
    );
    const connectedRows = container.querySelectorAll('.setting-row');
    expect(connectedRows).toHaveLength(2);
    expect(connectedRows[0].textContent).toContain('My computer');
    expect(connectedRows[0].textContent).toContain(
      'settings.localAgentThisDevice',
    );
    expect(connectedRows[0].querySelector('button')?.textContent).toBe(
      'settings.localAgentDisconnect',
    );
    expect(connectedRows[1].textContent).toContain('Server: linux x64');
  });
});
