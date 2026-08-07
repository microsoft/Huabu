// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: mocks.app,
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        mocks.handlers.set(channel, handler);
      },
    ),
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: mocks.autoUpdater,
}));

describe('desktop updater IPC', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.listeners.clear();
    mocks.app.isPackaged = true;
    mocks.autoUpdater.autoDownload = true;
    mocks.autoUpdater.autoInstallOnAppQuit = false;
    mocks.autoUpdater.on.mockImplementation(
      (event: string, listener: (...args: unknown[]) => void) => {
        mocks.listeners.set(event, listener);
        return mocks.autoUpdater;
      },
    );
    mocks.autoUpdater.checkForUpdates.mockResolvedValue(null);
    mocks.autoUpdater.downloadUpdate.mockResolvedValue([]);
  });

  async function register() {
    const send = vi.fn();
    const { registerUpdaterIpc } = await import('./updater.js');
    registerUpdaterIpc(
      () =>
        ({
          webContents: { isDestroyed: () => false, send },
        }) as never,
    );
    return { send };
  }

  it('returns the latest check status and broadcasts updater events', async () => {
    const { send } = await register();

    mocks.listeners.get('update-available')?.({
      version: '1.2.3',
      releaseNotes: 'Changes',
      releaseDate: '2026-07-22',
    });

    expect(send).toHaveBeenCalledWith('update:status', {
      state: 'available',
      version: '1.2.3',
      releaseNotes: 'Changes',
      releaseDate: '2026-07-22',
    });
    await expect(mocks.handlers.get('update:check')?.()).resolves.toEqual({
      ok: true,
      status: {
        state: 'available',
        version: '1.2.3',
        releaseNotes: 'Changes',
        releaseDate: '2026-07-22',
      },
    });
    expect(mocks.autoUpdater.autoDownload).toBe(false);
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('returns unavailable action results in an unpackaged app', async () => {
    mocks.app.isPackaged = false;
    await register();

    const unavailable = {
      ok: false,
      error: 'Updates are only available in the installed app.',
    };
    await expect(mocks.handlers.get('update:check')?.()).resolves.toEqual(
      unavailable,
    );
    await expect(mocks.handlers.get('update:download')?.()).resolves.toEqual(
      unavailable,
    );
    expect(mocks.handlers.get('update:install')?.()).toEqual(unavailable);
    expect(mocks.autoUpdater.on).not.toHaveBeenCalled();
  });

  it('a failed check clears checking and is claimed so the shared error never badges it', async () => {
    const checkError = new Error('offline');
    mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce(checkError);
    const { send } = await register();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    // Header flips to 'checking', then the check fails.
    mocks.listeners.get('checking-for-update')?.();
    const result = mocks.handlers.get('update:check')?.();
    // electron-updater also emits the shared 'error' with the SAME instance
    // the checkForUpdates() promise rejects with.
    mocks.listeners.get('error')?.(checkError);
    await expect(result).resolves.toEqual({ ok: false, error: 'offline' });

    // Flush the deferred shared-error handler.
    await new Promise((resolve) => setImmediate(resolve));

    // The check handler cleared the transient 'checking' back to idle...
    expect(send).toHaveBeenCalledWith('update:status', { state: 'idle' });
    // ...no persistent badge, and the claimed error produced no stray log.
    expect(send).not.toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'error' }),
    );
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('reports a user-driven check failure without an error badge', async () => {
    mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('boom'));
    const { send } = await register();

    // The renderer gets the reason back to show as a transient toast...
    await expect(mocks.handlers.get('update:check')?.()).resolves.toEqual({
      ok: false,
      error: 'boom',
    });
    // ...but a failed check never raises the persistent "Update failed" badge.
    expect(send).not.toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'error' }),
    );
  });

  it('surfaces a user download failure via the download promise, not the shared error event', async () => {
    // The download failure is carried by downloadUpdate()'s own rejection,
    // so the persistent "Update failed" badge is owned by the download
    // handler's catch. electron-updater also emits the shared 'error'
    // event with the SAME instance; that event, seeing the error already
    // claimed, must add nothing.
    const downloadError = new Error('download failed');
    let failDownload!: () => void;
    mocks.autoUpdater.downloadUpdate.mockImplementationOnce(
      () =>
        new Promise<never[]>((_resolve, reject) => {
          failDownload = () => reject(downloadError);
        }),
    );
    const { send } = await register();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const downloadPromise = mocks.handlers.get('update:download')?.();

    // A six-hourly background poll runs mid-download...
    void mocks.listeners.get('checking-for-update')?.();
    // ...then the download fails: electron-updater rejects the promise AND
    // emits the shared 'error' with the SAME instance.
    failDownload();
    mocks.listeners.get('error')?.(downloadError);

    await expect(downloadPromise).resolves.toEqual({
      ok: false,
      error: 'download failed',
    });
    // Flush the deferred shared-error handler.
    await new Promise((resolve) => setImmediate(resolve));

    // The badge is raised once, by the download handler's catch; the claimed
    // shared error adds nothing (no stray log, no second error status).
    expect(send).toHaveBeenCalledWith('update:status', {
      state: 'error',
      message: 'download failed',
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does NOT raise the error badge when a background check fails mid-download', async () => {
    // Reverse race: a large user download is still in flight (promise kept
    // pending) when a six-hourly background *check* fails. The check failure
    // must not be misread as the download failing (the pre-fix count race).
    let finishDownload!: () => void;
    mocks.autoUpdater.downloadUpdate.mockImplementationOnce(
      () =>
        new Promise<never[]>((resolve) => {
          finishDownload = () => resolve([]);
        }),
    );
    const { send } = await register();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const downloadPromise = mocks.handlers.get('update:download')?.();

    // A background check runs mid-download and fails via the shared event.
    void mocks.listeners.get('checking-for-update')?.();
    mocks.listeners.get('error')?.(new Error('offline'));

    // Flush the deferred shared-error handler.
    await new Promise((resolve) => setImmediate(resolve));

    expect(consoleError).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'error' }),
    );

    // ...and the user's own download is unaffected and still completes.
    finishDownload();
    await expect(downloadPromise).resolves.toEqual({ ok: true });
    consoleError.mockRestore();
  });

  it('raises the persistent error badge when installation fails to launch', async () => {
    const { send } = await register();

    // User clicks "Restart to update"; the handler returns immediately and
    // schedules quitAndInstall via setImmediate.
    expect(mocks.handlers.get('update:install')?.()).toEqual({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalled();

    // The installer can't launch: electron-updater emits the shared 'error'
    // with an error no operation promise claims. With an install committed
    // it must surface as "update failed", not a silent check-failure log.
    mocks.listeners.get('error')?.(new Error('installer missing'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(send).toHaveBeenCalledWith('update:status', {
      state: 'error',
      message: 'installer missing',
    });
  });

  it('attributes a coincident check failure and the real install failure separately', async () => {
    const checkError = new Error('offline');
    mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce(checkError);
    const { send } = await register();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    // User commits to "Restart to update".
    expect(mocks.handlers.get('update:install')?.()).toEqual({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalled();

    // A check that was already in flight fails: its promise rejects (claiming
    // the error) AND electron-updater emits the shared 'error' with the SAME
    // instance.
    const checkResult = mocks.handlers.get('update:check')?.();
    mocks.listeners.get('error')?.(checkError);
    await expect(checkResult).resolves.toEqual({ ok: false, error: 'offline' });

    // The real installer failure follows — a distinct, UNclaimed error.
    const installError = new Error('installer missing');
    mocks.listeners.get('error')?.(installError);

    // Flush both deferred shared-error handlers.
    await new Promise((resolve) => setImmediate(resolve));

    // The coincident check error is claimed, so it never becomes a badge
    // (doc contract: a check failure never shows the persistent badge)...
    expect(send).not.toHaveBeenCalledWith('update:status', {
      state: 'error',
      message: 'offline',
    });
    // ...and only the real install failure raises — not swallowed as a check.
    expect(send).toHaveBeenCalledWith('update:status', {
      state: 'error',
      message: 'installer missing',
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
