// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  dismissToast: vi.fn(),
  toast: vi.fn(() => 'checking-toast'),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../components/Common/Toast', () => ({
  dismissToast: mocks.dismissToast,
  toast: mocks.toast,
}));

vi.mock('./useElectron', () => ({
  getElectronBridge: () => ({
    updater: {
      check: mocks.check,
      download: mocks.download,
      install: mocks.install,
      getState: vi.fn().mockResolvedValue({ state: 'idle' }),
      onStatus: vi.fn(() => vi.fn()),
    },
  }),
}));

import { canCheckForUpdates, useAppUpdate } from './useAppUpdate';

import type { UpdateStatus } from './useElectron';

describe('canCheckForUpdates', () => {
  const cases: Array<[UpdateStatus, boolean]> = [
    [{ state: 'idle' }, true],
    [{ state: 'not-available', version: '1.0.0' }, true],
    [{ state: 'error', message: 'offline' }, true],
    [{ state: 'checking' }, false],
    [{ state: 'available', version: '1.1.0' }, false],
    [
      {
        state: 'downloading',
        percent: 50,
        transferred: 50,
        total: 100,
        bytesPerSecond: 10,
      },
      false,
    ],
    [{ state: 'downloaded', version: '1.1.0' }, false],
  ];

  it.each(cases)('returns %s for %o', (status, expected) => {
    expect(canCheckForUpdates(status)).toBe(expected);
  });
});

describe('useAppUpdate manual check feedback', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toast.mockReturnValue('checking-toast');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function clickCheck() {
    function Harness() {
      const { check } = useAppUpdate();
      return createElement('button', { onClick: check }, 'check');
    }

    await act(async () => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      container.querySelector('button')?.click();
      await Promise.resolve();
    });
  }

  it('replaces the checking toast with an up-to-date result', async () => {
    mocks.check.mockResolvedValue({
      ok: true,
      status: { state: 'not-available', version: '1.0.0' },
    });

    await clickCheck();

    expect(mocks.toast).toHaveBeenNthCalledWith(1, 'update.checking', {
      tone: 'info',
      duration: 0,
      dismissible: false,
    });
    expect(mocks.dismissToast).toHaveBeenCalledWith('checking-toast');
    expect(mocks.toast).toHaveBeenNthCalledWith(2, 'update.currentVersion', {
      tone: 'success',
    });
  });

  it('replaces the checking toast with an error result', async () => {
    mocks.check.mockResolvedValue({
      ok: false,
      error: 'Updates are only available in the installed app.',
    });

    await clickCheck();

    expect(mocks.dismissToast).toHaveBeenCalledWith('checking-toast');
    expect(mocks.toast).toHaveBeenNthCalledWith(2, 'update.checkFailed', {
      tone: 'danger',
    });
  });

  it('uses inline Shell feedback instead of an invisible cross-view toast', async () => {
    const feedback = vi.fn();
    mocks.check.mockResolvedValue({
      ok: true,
      status: { state: 'not-available', version: '1.0.0' },
    });
    function Harness() {
      const { check } = useAppUpdate(feedback);
      return createElement('button', { onClick: check }, 'check');
    }
    await act(async () => root.render(createElement(Harness)));
    await act(async () => {
      container.querySelector('button')?.click();
      await Promise.resolve();
    });
    expect(feedback).toHaveBeenNthCalledWith(1, 'update.checking', 'info');
    expect(feedback).toHaveBeenNthCalledWith(
      2,
      'update.currentVersion',
      'success',
    );
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.dismissToast).not.toHaveBeenCalled();
  });

  it.each(['download', 'install'] as const)(
    'surfaces a refused %s operation',
    async (operation) => {
      const feedback = vi.fn();
      mocks[operation].mockResolvedValue({
        ok: false,
        error: 'Space could not be saved',
      });
      function Harness() {
        const actions = useAppUpdate(feedback);
        return createElement(
          'button',
          { onClick: actions[operation] },
          operation,
        );
      }
      await act(async () => root.render(createElement(Harness)));
      await act(async () => {
        container.querySelector('button')?.click();
        await Promise.resolve();
      });
      expect(feedback).toHaveBeenCalledWith(
        'Space could not be saved',
        'danger',
      );
    },
  );
});
