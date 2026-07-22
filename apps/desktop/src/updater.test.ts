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
    const { registerUpdaterIpc } = await import('./updater');
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
});
