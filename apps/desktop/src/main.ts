/**
 * Huabu Electron main process.
 *
 * Responsibilities:
 *   1. Pick a free TCP port.
 *   2. Launch the Fastify server as a Node.js utility process with
 *      all required environment variables injected.
 *   3. Wait for the server to accept connections, then open the BrowserWindow.
 *   4. Gracefully shut down the server on app quit.
 *
 * The web UI (apps/web) is a static SPA served by the Fastify server
 * itself (via WEB_DIST_PATH). No separate renderer Vite dev server is
 * used in production — the BrowserWindow simply loads
 * `http://127.0.0.1:<port>`.
 *
 * Development shortcut:
 *   WEB_DEV_SERVER_URL env var can be set to `http://localhost:5173` to
 *   load the Vite dev server instead, giving live HMR for web code while
 *   the Electron shell is being iterated on. Run `pnpm dev:web` in a
 *   separate terminal first.
 *
 * Note: the npm/pnpm package name remains `@sediment/desktop` for monorepo
 * tooling continuity, but the product is branded as "Huabu" everywhere a
 * user can see it (window title, installer, Start Menu entry, log dir, etc.).
 */

import { execFile } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import net from 'node:net';
import { isAbsolute, join } from 'node:path';

import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { utilityProcess, type UtilityProcess } from 'electron';
import getPort from 'get-port';

import { TITLE_BAR_HEIGHT } from './title-bar.js';

import type { WriteStream } from 'node:fs';

// ── Constants ────────────────────────────────────────────────────────

const IS_DEV = !app.isPackaged;

/**
 * Force the user-facing Electron app name to "Huabu" regardless of whether
 * we're running packaged (where `productName` from electron-builder.yml is
 * already injected) or in dev via `electron .` (where `app.getName()` would
 * otherwise fall back to `package.json`'s npm name `@sediment/desktop`).
 *
 * This single call keeps `app.getPath('logs' | 'userData' | 'sessionData')`
 * pointing at a clean `Huabu/` folder in both environments, so users don't
 * see a leaked internal package name in dialogs or filesystem paths.
 *
 * Must be invoked before `app.whenReady()` to take effect.
 */
app.setName('Huabu');

/**
 * Resolve the on-disk path to a runtime icon asset.
 *
 * `electron-builder`'s `build-resources/icon.*` files only embed themselves
 * into the packaged executable — they do NOT set the running window/dock
 * icon. We have to point Electron at the file ourselves at runtime.
 *
 * In dev, the files live in the repo at `apps/desktop/build-resources/`.
 * In prod, they are shipped via `extraResources` to `Resources/icons/`.
 *
 * Returns `undefined` if the file is missing — Electron will then fall back
 * to its default icon rather than crashing.
 */
function resolveIconPath(filename: string): string | undefined {
  const candidate = IS_DEV
    ? join(__dirname, '../build-resources', filename)
    : join(process.resourcesPath, 'icons', filename);
  return existsSync(candidate) ? candidate : undefined;
}
const PREFERRED_PORT = 3001;

/**
 * Number of per-launch server log files to keep on disk before pruning
 * the oldest. Each launch creates one timestamped file in
 * `app.getPath('logs')`; typical size is single-digit MBs, so capping at
 * 10 keeps total disk usage well under 100MB.
 */
const MAX_LOG_FILES = 10;

// Last-resort safety net: log EIO/EPIPE on stdio so the main process
// doesn't die silently when its parent terminal closes. Anything else
// still surfaces via Electron's default crash dialog.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err && (err.code === 'EIO' || err.code === 'EPIPE')) {
    return;
  }
  throw err;
});

// ── Shell PATH harvest ───────────────────────────────────────────────

/**
 * Packaged apps launched via Finder/Dock/Launchpad inherit a minimal
 * PATH from launchd (typically `/usr/bin:/bin:/usr/sbin:/sbin` on
 * macOS), which omits common install locations like `/opt/homebrew/bin`
 * or `~/.nvm/.../bin` where users keep ACP-capable CLIs (`copilot`,
 * `claude`, `gemini`). The server's host-CLI detection (`which
 * <binary>`) then finds nothing and Settings → Built-in shows an empty
 * agent list — even though the same binaries are reachable from the
 * user's Terminal.
 *
 * To paper over that without forcing a Terminal relaunch, we run the
 * user's interactive login shell once at startup and harvest its
 * resolved PATH, then prepend the new entries onto `process.env.PATH`.
 * `buildServerEnv` already spreads `process.env` into the forked
 * server, so the child inherits the augmented value transparently.
 *
 * Skipped in dev (the Terminal-launched Electron already inherits the
 * shell PATH) and on Windows (Explorer-launched apps already see the
 * registry PATH; no dotfile-driven equivalent). Failure is non-fatal —
 * we keep the launchd PATH and surface the detection gap in the UI.
 */
async function ensureShellPath(): Promise<void> {
  if (IS_DEV) return;
  if (process.platform === 'win32') return;
  // Only trust an ABSOLUTE, EXISTING shell path. `process.env.SHELL` is
  // user-controlled: if it were unset, relative, or pointed at a missing
  // file, `execFile` would fall back to PATH resolution and could launch
  // an unintended binary. Anything that fails these checks degrades to the
  // POSIX-guaranteed `/bin/sh`.
  const rawShell = process.env.SHELL?.trim();
  const shellPath =
    rawShell && isAbsolute(rawShell) && existsSync(rawShell)
      ? rawShell
      : '/bin/sh';
  const MARKER = '__HUABU_PATH__:';
  try {
    const harvested = await new Promise<string>((resolve, reject) => {
      execFile(
        shellPath,
        ['-ilc', `printf '%s' "${MARKER}$PATH"`],
        { timeout: 3_000, windowsHide: true },
        (err, stdout) => {
          if (err) return reject(err);
          const idx = stdout.lastIndexOf(MARKER);
          if (idx === -1)
            return reject(new Error('PATH marker missing from shell output'));
          resolve(stdout.slice(idx + MARKER.length).trim());
        },
      );
    });
    if (!harvested) return;
    const existing = (process.env.PATH ?? '').split(':').filter(Boolean);
    const seen = new Set(existing);
    const additions: string[] = [];
    for (const entry of harvested.split(':')) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      additions.push(entry);
    }
    if (additions.length === 0) return;
    process.env.PATH = [...additions, ...existing].join(':');
    console.log(
      `[desktop] augmented PATH from ${shellPath} (+${additions.length} entries)`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[desktop] login-shell PATH probe failed (${shellPath}): ${message}`,
    );
  }
}

// ── Server process ───────────────────────────────────────────────────

let serverProcess: UtilityProcess | null = null;
let serverPort = 0;
let serverLogStream: WriteStream | null = null;

/**
 * Open (and rotate) a per-launch server log file under `app.getPath('logs')`.
 *
 * The trailing folder name is derived by Electron from `productName` in
 * `electron-builder.yml`, which is "Huabu".
 *
 * macOS  → `~/Library/Logs/Huabu/`
 * Win    → `%APPDATA%\Huabu\logs\`
 * Linux  → `~/.config/Huabu/logs/`
 *
 * Layout: one file per launch, timestamped, so a crash investigation
 * maps cleanly to a single file. At open time we prune everything
 * beyond {@link MAX_LOG_FILES} so the directory does not grow without
 * bound across long-running installs.
 *
 * The returned stream has an `error` handler attached that **unpipes
 * itself from the server's stdio** on any I/O failure (disk full,
 * antivirus lock, permission revoked). This is critical: without it,
 * stream backpressure from a broken log file would propagate all the
 * way back to the server's `console.log`/pino writes and stall request
 * handling. The always-on no-op drain installed in {@link startServer}
 * keeps the pipe buffer flushed even after we detach.
 *
 * Returns `null` if the logs directory can't be created (very rare —
 * permission issues on a fresh install). Callers should treat that
 * as "prod runs without persistent logs" rather than fatal.
 */
function openServerLogStream(): WriteStream | null {
  let logsDir: string;
  try {
    logsDir = app.getPath('logs');
    mkdirSync(logsDir, { recursive: true });
  } catch (err) {
    console.error('[desktop] could not prepare logs dir:', err);
    return null;
  }

  // Rotate: delete oldest files beyond MAX_LOG_FILES. Best-effort —
  // a single failed unlink should not block server startup.
  try {
    const existing = readdirSync(logsDir)
      .filter((f) => f.startsWith('server-') && f.endsWith('.log'))
      .map((f) => ({ f, mtime: statSync(join(logsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime); // newest first
    for (const { f } of existing.slice(MAX_LOG_FILES - 1)) {
      try {
        unlinkSync(join(logsDir, f));
      } catch {
        /* best-effort prune */
      }
    }
  } catch {
    /* best-effort prune */
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(logsDir, `server-${stamp}.log`);
  const stream = createWriteStream(file, { flags: 'a' });

  stream.on('error', (err) => {
    console.error('[desktop] server log stream error, detaching:', err);
    // Detach from the server pipes so future writes don't accumulate
    // backpressure. The no-op drain in startServer keeps consuming.
    if (serverLogStream === stream) {
      serverProcess?.stdout?.unpipe(stream);
      serverProcess?.stderr?.unpipe(stream);
      serverLogStream = null;
    }
  });

  return stream;
}

/**
 * Dev escape hatch: when `EXTERNAL_SERVER_URL` is set we skip forking
 * our bundled server entirely and treat the URL as the canonical
 * backend. This is what `scripts/dev-desktop.mjs` uses to wire up a
 * separately-managed `tsx watch` server, which gives full HMR for
 * `apps/server/src/**` and `packages/shared/src/**` (the watcher
 * restarts the server on change, Electron stays up).
 *
 * Returns the parsed URL when valid, otherwise undefined (we fall back
 * to spawning our own server).
 */
function getExternalServerUrl(): URL | undefined {
  if (!IS_DEV) return undefined;
  const raw = process.env.EXTERNAL_SERVER_URL?.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    console.warn(
      `[desktop] EXTERNAL_SERVER_URL="${raw}" is not a valid URL; falling back to in-process server.`,
    );
    return undefined;
  }
}

/**
 * Resolve the path to the Fastify server entry point.
 * In dev: apps/server/dist-bundle/server.js (built with `pnpm --filter @sediment/server bundle`)
 * In prod: extracted to Resources/server/server.js by electron-builder
 */
function resolveServerEntry(): string {
  if (IS_DEV) {
    return join(__dirname, '../../server/dist-bundle/server.js');
  }
  return join(process.resourcesPath, 'server', 'server.js');
}

/**
 * Build the environment for the server child process.
 * All HUABU_* vars are injected here — the server code reads them
 * via process.env and has fallbacks for the standalone (non-Electron) case.
 */
function buildServerEnv(port: number): NodeJS.ProcessEnv {
  const userData = app.getPath('userData');

  const dataDir = join(userData, 'data');
  // In production the SPA lives next to the server bundle in Resources/.
  // In dev, if the user opted into Vite HMR via WEB_DEV_SERVER_URL we
  // let Vite serve the SPA; otherwise fall back to serving the prebuilt
  // `apps/web/dist` from Fastify (run `pnpm --filter @sediment/web build`
  // once before `pnpm dev`).
  const webDistPath = IS_DEV
    ? process.env.WEB_DEV_SERVER_URL
      ? '' // Vite owns the SPA in this case
      : join(__dirname, '../../web/dist')
    : join(process.resourcesPath, 'web');

  // Ensure the data directory exists so the server doesn't have to
  // race-condition on first-use creation. The workspace directory is
  // intentionally NOT pre-created: in free mode the user picks it via
  // the in-app UI (folder picker / path input), and the web client
  // persists the selection across launches via localStorage.
  mkdirSync(dataDir, { recursive: true });

  if (IS_DEV && webDistPath && !existsSync(webDistPath)) {
    console.warn(
      `[desktop] WEB_DIST_PATH "${webDistPath}" does not exist. ` +
        `Run \`pnpm --filter @sediment/web build\` first, or set ` +
        `WEB_DEV_SERVER_URL=http://localhost:5173 and run \`pnpm dev:web\`.`,
    );
  }

  // Notably absent: HUABU_WORKSPACE. Omitting it puts the server in
  // free mode, so the web UI shows its workspace picker on first launch.
  //
  // External-agent (ACP) integration: the server embeds an `agentlet`
  // daemon supervisor (`DaemonSupervisor`) which fork()s the daemon
  // entry point itself. In packaged builds the entry resolves to
  // `<resources>/server/agentlet/index.js` (copied by tsup + bundled
  // by electron-builder, see ./electron-builder.yml extraResources);
  // in dev it falls back to `external/agentlet/packages/local/dist/index.js`.
  // No env var injection is needed here \u2014 the resolver in
  // `daemon-supervisor.ts` covers both layouts.
  return {
    ...process.env,
    SERVER_PORT: String(port),
    HUABU_BIND_HOST: '127.0.0.1',
    HUABU_DATA_DIR: dataDir,
    ...(webDistPath ? { WEB_DIST_PATH: webDistPath } : {}),
    NODE_ENV: IS_DEV ? 'development' : 'production',
  };
}

async function startServer(port: number): Promise<void> {
  const serverEntry = resolveServerEntry();

  if (!existsSync(serverEntry)) {
    await dialog.showErrorBox(
      'Huabu — Server not found',
      `Could not find the server bundle at:\n${serverEntry}\n\nPlease rebuild the project (pnpm --filter @sediment/server build).`,
    );
    app.quit();
    return;
  }

  serverProcess = utilityProcess.fork(serverEntry, [], {
    serviceName: 'sediment-server',
    env: buildServerEnv(port),
    // Pipe stdout/stderr so we can forward to a log file (prod) or to
    // the parent terminal (dev). Even with no consumer attached, Node
    // would otherwise let the pipe buffer fill and back-pressure the
    // server's writes — see the always-on no-op drain below.
    stdio: 'pipe',
  });

  // Always-on safety net: an `on('data')` listener (even empty) puts
  // the stream in flowing mode so the OS pipe buffer never fills up,
  // regardless of whether log forwarding / file-tee is attached or
  // detaches later due to I/O errors. Without this, a stalled consumer
  // would silently freeze every `console.log` / pino write on the
  // server side once ~16-64KB of unread output accumulates.
  serverProcess.stdout?.on('data', () => {});
  serverProcess.stderr?.on('data', () => {});
  serverProcess.stdout?.on('error', () => {});
  serverProcess.stderr?.on('error', () => {});

  if (IS_DEV) {
    // Forward server logs to our stdio. Wrap in try/catch + ignore EIO
    // because the parent process's stdout can be closed/unavailable (e.g.
    // when launched without a TTY or when the user closes the terminal),
    // and a raw write would crash the main process.
    const safeWrite = (
      stream: NodeJS.WriteStream,
      prefix: string,
      chunk: Buffer,
    ): void => {
      try {
        stream.write(`${prefix} ${chunk}`);
      } catch {
        // ignore broken pipe / EIO — server keeps running, we just stop logging.
      }
    };
    process.stdout.on('error', () => {});
    process.stderr.on('error', () => {});
    serverProcess.stdout?.on('data', (chunk: Buffer) =>
      safeWrite(process.stdout, '[server]', chunk),
    );
    serverProcess.stderr?.on('data', (chunk: Buffer) =>
      safeWrite(process.stderr, '[server]', chunk),
    );
  } else {
    // Prod: tee stdout/stderr to a rotating per-launch log file under
    // `app.getPath('logs')`. `{ end: false }` keeps the file handle
    // alive across the server's own stream lifecycle so we don't lose
    // it if/when the server is restarted within the same Electron
    // session. If `openServerLogStream` returns null (rare disk-perm
    // issue), we silently fall back to the no-op drain above — server
    // keeps running, we just have no persistent logs.
    serverLogStream = openServerLogStream();
    if (serverLogStream) {
      serverProcess.stdout?.pipe(serverLogStream, { end: false });
      serverProcess.stderr?.pipe(serverLogStream, { end: false });
      console.log(`[desktop] server logs → ${serverLogStream.path}`);
    }
  }

  serverProcess.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[desktop] server exited with code ${code}`);
    }
    serverProcess = null;
    // Close the log stream so the file handle is released and the
    // final buffered bytes hit disk before quit.
    serverLogStream?.end();
    serverLogStream = null;
  });
}

// ── Port / readiness ─────────────────────────────────────────────────

/**
 * Poll until the server port accepts a TCP connection or we time out.
 * Uses raw TCP (not HTTP) so it works before Fastify has registered routes.
 */
function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server did not start within ${timeoutMs / 1000}s`));
          return;
        }
        setTimeout(attempt, 200);
      });
    }
    attempt();
  });
}

// ── BrowserWindow ────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

function createWindow(port: number): void {
  // Per-platform title bar setup. The Huabu renderer always paints
  // its own 36px tall `WindowChrome` strip; what differs across OSes is
  // *who* draws the caption buttons (min/max/close):
  //   - Windows: `titleBarOverlay` keeps the native buttons in the
  //     top-right corner, just transparent over our HTML chrome. We
  //     hand it the same height so the buttons line up with our row.
  //   - macOS: `hiddenInset` keeps the traffic-light buttons; the
  //     renderer leaves a left-side gutter so they don't sit on top of
  //     our home button.
  //   - Linux: no overlay support yet, so we go fully frameless. v1
  //     ships without custom HTML buttons — users use the OS-level
  //     window manager shortcuts. We can wire IPC buttons later.
  const platformChrome:
    | { titleBarStyle: 'hidden'; titleBarOverlay: object }
    | { titleBarStyle: 'hiddenInset' }
    | { frame: false } =
    process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#ffffff',
            symbolColor: '#191919',
            height: TITLE_BAR_HEIGHT,
          },
        }
      : process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const }
        : { frame: false as const };

  // Prefer the .ico on Windows for crisp multi-resolution rendering in the
  // title-bar / taskbar; .png is fine everywhere else.
  const windowIcon = resolveIconPath(
    process.platform === 'win32' ? 'icon.ico' : 'icon.png',
  );

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Huabu',
    backgroundColor: '#ffffff',
    ...(windowIcon ? { icon: windowIcon } : {}),
    ...platformChrome,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload script only touches `contextBridge`, `process.versions`
      // and `process.platform` — all of which work in the sandbox. Keeping
      // sandbox ON gives us the OS-level renderer sandbox (seccomp / job
      // object / sandbox-init) on top of context isolation, which is the
      // recommended default for any window that loads remote-ish content
      // (even our own SPA over HTTP loopback).
      sandbox: true,
    },
  });

  // In dev, allow loading the Vite dev server for hot-reloadable web work.
  const devServerUrl = process.env.WEB_DEV_SERVER_URL;
  const url =
    IS_DEV && devServerUrl ? devServerUrl : `http://127.0.0.1:${port}`;

  void mainWindow.loadURL(url);

  // Open external links in the user's default browser, not inside Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith('http')) {
      void shell.openExternal(targetUrl);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Belt-and-braces navigation guard. `setWindowOpenHandler` covers
  // `target=_blank` / `window.open`; this catches the case where some
  // in-page script (or a stray <a href> without a click-handler) tries
  // to navigate the top-level frame off our loopback origin. We allow
  // same-origin navigations (so React Router's `history.pushState` and
  // a full-page reload during dev HMR continue to work) and shell out
  // anything else to the OS browser. Without this, a compromised page
  // could redirect the renderer at `file://` or an attacker-controlled
  // HTTP origin while keeping the Electron preload context alive.
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl.startsWith(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(targetUrl)) {
      void shell.openExternal(targetUrl);
    }
  });

  // Keyboard shortcuts scoped to *this* window's webContents instead
  // of the previous `globalShortcut.register` approach. Global hotkeys
  // intercept the key everywhere on the OS — even while Huabu is in
  // the background — which is a UX regression (steals F12 / Ctrl+R
  // from any focused app) and a packaging hazard (Wayland refuses to
  // register global accelerators at all). `before-input-event` fires
  // only when our window already has keyboard focus, which is exactly
  // what we want for DevTools / reload accelerators.
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const win = mainWindow;
    if (!win) return;

    const isReload =
      input.key === 'F5' ||
      ((input.control || input.meta) && input.key.toLowerCase() === 'r');
    if (isReload) {
      win.webContents.reload();
      return;
    }

    const isToggleDevTools =
      input.key === 'F12' ||
      (process.platform === 'darwin'
        ? (input.control || input.meta) &&
          input.alt &&
          input.key.toLowerCase() === 'i'
        : (input.control || input.meta) &&
          input.shift &&
          input.key.toLowerCase() === 'i');
    if (isToggleDevTools) {
      win.webContents.toggleDevTools();
    }
  });

  if (IS_DEV) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App lifecycle ────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Drop the default Electron Application menu (`File / Edit / View /
  // Window / Help`). The Huabu shell paints its own minimal title
  // bar — keeping the OS menu around just adds visual noise. Chromium
  // still wires up the usual editing keyboard accelerators (cut / copy
  // / paste / undo / select-all) without it, and our DevTools /
  // reload accelerators are re-bound per window via
  // `before-input-event` inside `createWindow`.
  Menu.setApplicationMenu(null);

  // macOS Dock icon. In a packaged .app this comes from the bundle's
  // .icns automatically, but in dev (`electron .`) the Dock would show
  // the generic Electron logo unless we override it explicitly.
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = resolveIconPath('icon.png');
    if (dockIcon) {
      app.dock.setIcon(dockIcon);
    }
  }

  try {
    // Augment PATH from the user's login shell BEFORE forking the
    // server so host-CLI detection (`which copilot` / `claude` /
    // `gemini`) sees the same entries the user has in their Terminal.
    // See `ensureShellPath` for rationale.
    await ensureShellPath();

    const external = getExternalServerUrl();
    if (external) {
      // External dev server: don't fork our own, just point at the
      // already-running one. We still wait for the port so the window
      // doesn't load before the server can answer `/api/*`.
      serverPort = Number.parseInt(
        external.port || (external.protocol === 'https:' ? '443' : '80'),
        10,
      );
      console.log(
        `[desktop] Using external server at ${external.origin} (skipping in-process fork)`,
      );
      await waitForPort(serverPort);
    } else {
      serverPort = await getPort({ port: PREFERRED_PORT });
      await startServer(serverPort);
      await waitForPort(serverPort);
    }
    createWindow(serverPort);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await dialog.showErrorBox('Huabu failed to start', message);
    app.quit();
  }
});

// macOS: re-create window when dock icon is clicked and no windows are open.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort > 0) {
    createWindow(serverPort);
  }
});

// Quit when all windows are closed (except on macOS).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Gracefully shut down the server before the process exits. We
// preventDefault and drive the quit ourselves so we can:
//   1. wait for the server to actually exit (its `'exit'` handler also
//      closes the rotating log stream — racing past it loses the last
//      few KB of buffered logs); and
//   2. enforce a hard cap so a hung server can never block quit. 3s is
//      generous: Fastify's default `closeGraceful` is ~10s, but we
//      pass `kill()` (SIGTERM on POSIX, terminate on Win), which
//      Fastify handles by draining in-flight requests synchronously.
let quitInFlight = false;
app.on('before-quit', (event) => {
  if (quitInFlight) return;
  const proc = serverProcess;
  if (!proc) return;
  quitInFlight = true;
  event.preventDefault();
  serverProcess = null;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
    app.exit(0);
  });
  proc.kill();
  setTimeout(() => {
    if (!exited) {
      console.warn(
        '[desktop] server did not exit within 3s after kill; forcing app.exit',
      );
      app.exit(0);
    }
  }, 3000);
});
