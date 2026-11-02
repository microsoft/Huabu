// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectedDeviceRow } from './ConnectedDeviceRow';

const api = vi.hoisted(() => ({
  rename: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/components/Common/Toast', () => ({ toast: api.toast }));
vi.mock('@/store/acpProfilesStore', () => ({
  useAcpProfilesStore: (
    selector: (state: { renameDevice: typeof api.rename }) => unknown,
  ) => selector({ renameDevice: api.rename }),
}));
vi.mock('react-i18next', async () => {
  const { createInstance } = await import('i18next');
  const { default: en } = await import('@/i18n/resources/en/common.json');
  const instance = createInstance();
  await instance.init({ lng: 'en', resources: { en: { translation: en } } });
  return { useTranslation: () => ({ t: instance.getFixedT('en') }) };
});

const device = {
  agentletId: 'c717d73c-7188-44ca-a6bd-67455f4cd3e8',
  displayName: 'Machine: linux x64',
  version: '1.0',
  profileCount: 1,
  connectedAt: '2026-01-01T00:00:00.000Z',
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openMenu() {
  await act(async () =>
    root.render(
      <ConnectedDeviceRow
        device={device}
        isLocalDevice
        connectionControls={<span>Disconnect</span>}
      />,
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label$=" actions"]')
      ?.click(),
  );
}

describe('device menu', () => {
  it('does not reopen a controlled menu after cancelling Rename', async () => {
    function LocalDevice() {
      const [open, setOpen] = useState(false);
      return (
        <ConnectedDeviceRow
          device={device}
          isLocalDevice
          menuOpen={open}
          onMenuOpenChange={setOpen}
        />
      );
    }
    await act(async () => root.render(<LocalDevice />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
        ?.click(),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click(),
    );
    expect(container.querySelector('input')).toBe(document.activeElement);
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Cancel')
        ?.click(),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[aria-haspopup="menu"]'),
    );
  });

  it('keeps offline metadata readable without inventing a version or offering online-only actions', async () => {
    await act(async () =>
      root.render(
        <ConnectedDeviceRow
          device={{ agentletId: 'offline', displayName: 'Offline PC' }}
          isLocalDevice={false}
          online={false}
          onAdd={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Not connected',
    );
    expect(container.querySelector('[data-editor-trigger]')).toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Offline PC actions"]')
        ?.click(),
    );
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('offline');
    expect(menu?.textContent).not.toContain('Version');
    expect(menu?.textContent).not.toContain('Rename');
  });

  it('shows identity directly below Rename without a bulk discovery action', async () => {
    await openMenu();
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('c717d73c…d3e8');
    expect(menu?.textContent).not.toContain(device.agentletId);
    expect(menu?.textContent).toContain('Version');
    expect(menu?.textContent).toContain(device.version);
    const items = [...(menu?.querySelectorAll('button') ?? [])];
    expect(
      items.map((item) => item.getAttribute('aria-label') ?? item.textContent),
    ).toEqual(['Rename', 'Copy device ID']);
    expect(container.textContent).toContain('This device');
    expect(container.textContent).not.toContain('(This device)');
    expect(container.textContent).toContain('Disconnect');
    await act(async () => items[0].click());
    expect(container.querySelector('input')).toBe(document.activeElement);
  });

  it.each([false, true])(
    'copies the exact device ID and reports clipboard failure: %s',
    async (fails) => {
      const writeText = fails
        ? vi.fn().mockRejectedValue(new Error('Clipboard unavailable'))
        : vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', {
        clipboard: { writeText },
        platform: navigator.platform,
        userAgent: navigator.userAgent,
      });
      await openMenu();
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('[aria-label="Copy device ID"]')
          ?.click(),
      );
      expect(writeText).toHaveBeenCalledExactlyOnceWith(device.agentletId);
      expect(api.toast).toHaveBeenCalledWith(
        fails ? 'Clipboard unavailable' : 'Device ID copied',
        { tone: fails ? 'danger' : 'success' },
      );
    },
  );
});
