// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
 * `publish` block in electron-builder.yml. electron-updater reads that
 * file itself — this module only drives the check/download/install
 * lifecycle and mirrors it to the renderer.
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

/**
 * Errors already "claimed" by the operation that produced them.
 *
 * electron-updater has a single shared `error` event for checks,
 * downloads, and installs, so it cannot tell them apart on its own. But a
 * check (`checkForUpdates()`) and a download (`downloadUpdate()`) each
 * reject their own promise with the SAME Error instance the shared event
 * also carries — so whoever awaits that promise records the instance
 * here. An install (`quitAndInstall()`) exposes no promise, so its
 * failure is the one error that reaches the shared event UNclaimed. That
 * is how we attribute each error to its operation by identity, rather
 * than by a blanket "an install is in flight" flag that would wrongly
 * swallow every coincident check error as an install failure.
 *
 * A WeakSet so claimed errors stay collectable once nothing else
 * references them; we never enumerate or clear it.
 */
const operationErrors = new WeakSet<object>();

function claimOperationError(err: unknown): void {
  if (typeof err === 'object' && err !== null) {
    operationErrors.add(err);
  }
}

/**
 * Whether an explicit "Restart to update" (`update:install`) has been
 * committed. `quitAndInstall()` can report a missing / un-launchable
 * installer through the shared `error` event *asynchronously* (the
 * installer is spawned detached). Because that error arrives UNclaimed
 * (install has no promise), the shared listener already recognises it as
 * an install failure via `operationErrors`; this flag only gates
 * *whether* to raise the persistent "Update failed" badge for such an
 * unclaimed error, so a stray error before any install request is logged
 * rather than badged. It latches on the first install request; it is
 * deliberately never cleared by a coincident check/download error —
 * attribution, not this flag, is what stops those from being mistaken for
 * the install's own (possibly late) failure.
 */
let installOpActive = false;

/**
 * The window resolver captured on {@link registerUpdaterIpc}, so the
 * background poll in {@link startAutoUpdateChecks} can publish status
 * transitions too. Registration always runs before polling starts.
 */
let resolveWindow: (() => BrowserWindow | null) | null = null;

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
  resolveWindow = getWindow;

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
      // Claim this error so the shared `error` event — which electron-updater
      // fires with the same instance — knows a check already owns it and
      // never mistakes it for an install failure. A failed *check* is not
      // "update failed": nothing was downloaded or installed, so we only
      // clear the transient 'checking' state; the renderer surfaces the
      // reason as a one-off toast from this result (see useAppUpdate.check()).
      claimOperationError(err);
      if (lastStatus.state === 'checking') {
        setStatus({ state: 'idle' }, getWindow);
      }
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
      // Claim this error so the shared `error` event (fired with the same
      // instance) treats it as download-owned, not an install failure. A
      // user-started download failing IS "update failed", so raise the
      // persistent badge here — owned by this catch, never inferred from a
      // shared flag a coincident background check could forge.
      claimOperationError(err);
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
    // relaunches the app. On success the app quits; on failure (installer
    // missing / cannot launch) electron-updater emits the shared `error`
    // event — possibly asynchronously, since the installer is spawned
    // detached — and with an error no operation promise claims. The shared
    // listener therefore recognises it as the install failure (see
    // `operationErrors`); `installOpActive` only gates raising the
    // persistent "Update failed" badge for such an unclaimed error.
    installOpActive = true;
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
    // electron-updater dispatches this synchronously, BEFORE the
    // check/download promise it also rejects (with the SAME error) settles.
    // Defer one macrotask so that operation's catch (a microtask) runs
    // first and claims the error. An error still unclaimed once the
    // microtask queue has drained was produced by no check/download we
    // initiated — i.e. a quitAndInstall() failure, the only operation with
    // no promise to carry it.
    setImmediate(() => {
      const message = err instanceof Error ? err.message : String(err);
      if (typeof err === 'object' && err !== null && operationErrors.has(err)) {
        // Already handled by its originating check/download; the shared
        // event is a redundant mirror for those, so there is nothing to do.
        return;
      }
      if (installOpActive) {
        // After an install request, the one unclaimed error source is the
        // installer itself — surface it as the persistent "Update failed"
        // badge, even when it arrives async and even when a background
        // check failed first (that check error was claimed above).
        setStatus({ state: 'error', message }, getWindow);
        return;
      }
      // A stray error with no owning operation and no install committed
      // installs nothing, so it never raises the badge — just log it.
      console.error('[updater] update error:', message);
    });
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
    // Background poll. It owns its own failure: claim the error so the
    // shared `error` event cannot mistake it for an install, log it (a
    // check installs nothing, so never a badge), and clear any transient
    // 'checking' state. This holds even while a user download or install
    // is in flight, because attribution — not a shared flag — decides.
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      claimOperationError(err);
      const message = err instanceof Error ? err.message : String(err);
      console.error('[updater] update check failed:', message);
      if (resolveWindow && lastStatus.state === 'checking') {
        setStatus({ state: 'idle' }, resolveWindow);
      }
    });
  };

  setTimeout(check, INITIAL_CHECK_DELAY_MS);
  pollTimer = setInterval(check, CHECK_INTERVAL_MS);
  // Don't let the interval keep the event loop alive on quit.
  pollTimer.unref?.();
}
