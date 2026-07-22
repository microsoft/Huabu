/**
 * Auto-update wiring for the Huabu desktop app (electron-updater).
 *
 * Policy (deliberately non-intrusive):
 *   - We NEVER auto-download. The renderer is told when an update is
 *     available and the user explicitly clicks "Download", then "Restart
 *     to update". This keeps large downloads and restarts under user
 *     control (see `autoDownload = false`).
 *   - We check on startup, then periodically, and on explicit renderer
 *     request (the header "check for updates" affordance).
 *
 * The update feed (GitHub owner/repo) is NOT configured here. It is
 * baked into the packaged app's `app-update.yml` at build time from the
 * HUABU_UPDATE_OWNER / HUABU_UPDATE_REPO env vars (see electron-builder.yml).
 * electron-updater reads that file itself — this module only drives the
 * check/download/install lifecycle and mirrors it to the renderer.
 *
 * All lifecycle transitions are pushed to the focused window over the
 * `update:status` channel, and the latest snapshot is cached so a
 * freshly-mounted renderer can sync via the `update:get-state` handler.
 *
 * Everything here no-ops when the app is not packaged: electron-updater
 * cannot resolve an `app-update.yml` in `electron .` dev runs, so IPC
 * handlers return a friendly "unavailable" result instead of throwing.
 */

import { app, ipcMain, type BrowserWindow } from 'electron';
// electron-updater is a CommonJS module that marks itself `__esModule`
// but exposes `autoUpdater` only as a NAMED export (there is no default
// export). Under our `module: CommonJS` build a `import x from
// 'electron-updater'` therefore resolves `x` to `undefined` and
// destructuring `autoUpdater` off it throws at load time. A named import
// compiles to `require('electron-updater').autoUpdater`, which is correct.
import { autoUpdater } from 'electron-updater';

/**
 * Discriminated snapshot of the updater lifecycle mirrored to the
 * renderer. Keep this in lockstep with the `UpdateStatus` type declared
 * on the web side in `apps/web/src/hooks/useElectron.ts`.
 */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | {
      state: 'available';
      version: string;
      releaseNotes?: string;
      releaseDate?: string;
    }
  | { state: 'not-available'; version: string }
  | {
      state: 'downloading';
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

type UpdateActionResult = { ok: true } | { ok: false; error: string };
type UpdateCheckResult =
  | { ok: true; status: UpdateStatus }
  | { ok: false; error: string };

/**
 * Re-check interval once the app is running. Six hours balances "notice
 * a release the same day" against not hammering the GitHub releases API
 * on a machine left open for weeks.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Delay the very first check until after the window has settled so the
 * network probe never competes with first-paint / server boot.
 */
const INITIAL_CHECK_DELAY_MS = 8_000;

let lastStatus: UpdateStatus = { state: 'idle' };
let wired = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function isPackaged(): boolean {
  return app.isPackaged;
}

function normalizeReleaseNotes(
  notes: string | Array<{ note: string | null }> | null | undefined,
): string | undefined {
  if (!notes) return undefined;
  if (typeof notes === 'string') return notes;
  const joined = notes
    .map((entry) => entry.note ?? '')
    .filter((note) => note.length > 0)
    .join('\n\n');
  return joined.length > 0 ? joined : undefined;
}

function publishStatus(getWindow: () => BrowserWindow | null): void {
  const win = getWindow();
  if (win && !win.webContents.isDestroyed()) {
    win.webContents.send('update:status', lastStatus);
  }
}

function setStatus(
  next: UpdateStatus,
  getWindow: () => BrowserWindow | null,
): void {
  lastStatus = next;
  publishStatus(getWindow);
}

/**
 * Attach electron-updater event listeners and register the IPC surface.
 * Safe to call once; subsequent calls are ignored. Does nothing in an
 * unpackaged dev run beyond registering the IPC handlers (which then
 * report "unavailable"), so the renderer bridge always has a responder.
 */
export function registerUpdaterIpc(
  getWindow: () => BrowserWindow | null,
): void {
  if (wired) return;
  wired = true;

  ipcMain.handle('update:get-state', (): UpdateStatus => lastStatus);

  ipcMain.handle('update:check', async (): Promise<UpdateCheckResult> => {
    if (!isPackaged()) {
      return {
        ok: false,
        error: 'Updates are only available in the installed app.',
      };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true, status: lastStatus };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ state: 'error', message }, getWindow);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('update:download', async (): Promise<UpdateActionResult> => {
    if (!isPackaged()) {
      return {
        ok: false,
        error: 'Updates are only available in the installed app.',
      };
    }
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ state: 'error', message }, getWindow);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('update:install', (): UpdateActionResult => {
    if (!isPackaged()) {
      return {
        ok: false,
        error: 'Updates are only available in the installed app.',
      };
    }
    // `quitAndInstall` triggers `before-quit`, so the main process's
    // cooperative server-shutdown path still runs before the installer
    // relaunches the app.
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  });

  if (!isPackaged()) return;

  // User drives download + restart explicitly.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    setStatus({ state: 'checking' }, getWindow);
  });
  autoUpdater.on('update-available', (info) => {
    setStatus(
      {
        state: 'available',
        version: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        releaseDate: info.releaseDate,
      },
      getWindow,
    );
  });
  autoUpdater.on('update-not-available', (info) => {
    setStatus({ state: 'not-available', version: info.version }, getWindow);
  });
  autoUpdater.on('download-progress', (progress) => {
    setStatus(
      {
        state: 'downloading',
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
      getWindow,
    );
  });
  autoUpdater.on('update-downloaded', (info) => {
    setStatus({ state: 'downloaded', version: info.version }, getWindow);
  });
  autoUpdater.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err);
    setStatus({ state: 'error', message }, getWindow);
  });
}

/**
 * Kick off the startup check and schedule periodic re-checks. No-op when
 * unpackaged. Failures are swallowed — a background check that can't
 * reach GitHub must never surface a dialog or block the app.
 */
export function startAutoUpdateChecks(): void {
  if (!isPackaged()) return;

  const check = (): void => {
    autoUpdater.checkForUpdates().catch(() => {
      // Surfaced via the 'error' event listener; nothing to do here.
    });
  };

  setTimeout(check, INITIAL_CHECK_DELAY_MS);
  pollTimer = setInterval(check, CHECK_INTERVAL_MS);
  // Don't let the interval keep the event loop alive on quit.
  pollTimer.unref?.();
}
