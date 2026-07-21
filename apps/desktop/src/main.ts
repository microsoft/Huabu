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
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { release as getOsRelease } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
} from 'electron';
import { utilityProcess, type UtilityProcess } from 'electron';
import getPort from 'get-port';

import { applyApplicationMenu, registerMenuIpc } from './mac-menu.js';
import {
  DesktopSecureSecretStore,
  isDesktopSecretId,
} from './secure-secrets.js';
import { TITLE_BAR_HEIGHT } from './title-bar.js';

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
 * How much of the server's stderr to keep in memory at any given time.
 * On non-zero exit we dump this ring buffer to a `crash-<ts>-exit<code>.log`
 * file under `app.getPath('logs')/crashes/` for post-mortem investigation.
 *
 * 256 KB easily covers a typical Node stack trace + a few hundred lines
 * of pino JSON leading up to the failure, while keeping idle memory cost
 * trivial. The on-disk crash file is also bounded to this size.
 */
const STDERR_RING_BYTES = 256 * 1024;

/**
 * Cap on retained `crash-*.log` files. After each crash dump we prune
 * the oldest beyond this count so a flapping server can't fill the disk.
 */
const MAX_CRASH_FILES = 10;

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
let secureSecretStore: DesktopSecureSecretStore | null = null;
/**
 * Ring buffer of the server child's most recent stderr output. Reset on
 * each fork. Drained to a crash-dump file only when the child exits with
 * a non-zero code; otherwise it's discarded silently — successful runs
 * leave no extra files behind. The server's own pino logger (writing to
 * `<userData>/data/logs/server.log`) remains the canonical persistent log.
 */
let stderrRing: Buffer = Buffer.alloc(0);

/**
 * Number of times we'll re-fork the server on a fresh port after an
 * early bind failure (EADDRINUSE) or immediate exit. Three attempts
 * covers the realistic case where a stale Huabu / dev orchestrator is
 * holding the previous port and another local service grabs the next
 * one before we can bind. After that we surface the original error so
 * the user can investigate instead of spinning forever.
 */
const MAX_SERVER_START_ATTEMPTS = 3;

/**
 * Resolved when the forked server child exits. We track it on a module
 * scope so {@link waitForPort} can race against it: if the child dies
 * before its port becomes reachable we must abort the readiness wait
 * (otherwise a *foreign* process holding the same port — e.g. a leftover
 * dev server — would make the wait spuriously succeed and we'd load
 * a phantom backend into the BrowserWindow).
 */
let serverExitPromise: Promise<{
  code: number | null;
  signal: string | null;
}> | null = null;

/**
 * Append a chunk to the bounded {@link stderrRing} buffer, trimming the
 * oldest bytes once we exceed {@link STDERR_RING_BYTES}. Cheap enough to
 * run on every stderr chunk; never throws.
 */
function appendStderrRing(chunk: Buffer): void {
  stderrRing =
    stderrRing.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([stderrRing, chunk]);
  if (stderrRing.length > STDERR_RING_BYTES) {
    stderrRing = stderrRing.subarray(stderrRing.length - STDERR_RING_BYTES);
  }
}

/**
 * Drop the oldest `crash-*.log` files in `dir` once the count exceeds
 * {@link MAX_CRASH_FILES}. Best-effort — any FS error is swallowed so a
 * single broken file can't block subsequent crash captures.
 */
function pruneOldCrashFiles(dir: string): void {
  try {
    const existing = readdirSync(dir)
      .filter((f) => f.startsWith('crash-') && f.endsWith('.log'))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime); // newest first
    for (const { f } of existing.slice(MAX_CRASH_FILES)) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* best-effort prune */
      }
    }
  } catch {
    /* best-effort prune */
  }
}

/**
 * Write the captured stderr ring buffer to a crash-dump file under
 * `app.getPath('logs')/crashes/` and prune old entries. Called only on
 * non-zero server exit; no-ops if the ring is empty.
 *
 * Folder layout:
 *   macOS  → `~/Library/Logs/Huabu/crashes/crash-<ts>-exit<code>.log`
 *   Win    → `%APPDATA%\Huabu\logs\crashes\crash-<ts>-exit<code>.log`
 *   Linux  → `~/.config/Huabu/logs/crashes/crash-<ts>-exit<code>.log`
 *
 * Errors are swallowed: a missing crash dump is annoying but must never
 * block the rest of shutdown / restart logic.
 */
function dumpServerCrash(exitCode: number): void {
  if (stderrRing.length === 0) return;
  try {
    const crashDir = join(app.getPath('logs'), 'crashes');
    mkdirSync(crashDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(crashDir, `crash-${stamp}-exit${exitCode}.log`);
    writeFileSync(file, stderrRing);
    pruneOldCrashFiles(crashDir);
    console.error(`[desktop] server crash dump written → ${file}`);
  } catch (err) {
    console.error('[desktop] failed to write server crash dump:', err);
  }
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
    HUABU_SECRET_BRIDGE: '1',
    ...(webDistPath ? { WEB_DIST_PATH: webDistPath } : {}),
    NODE_ENV: IS_DEV ? 'development' : 'production',
  };
}

async function startServer(port: number): Promise<void> {
  const serverEntry = resolveServerEntry();
  const secretSnapshot = secureSecretStore?.snapshot() ?? {};

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
  const child = serverProcess;

  child.on('message', (message: unknown) => {
    if (!secureSecretStore || !message || typeof message !== 'object') return;
    const request = message as Record<string, unknown>;
    if (
      request.type !== 'secret:mutate' ||
      typeof request.requestId !== 'string'
    ) {
      return;
    }
    if (
      typeof request.key !== 'string' ||
      !isDesktopSecretId(request.key) ||
      (request.value !== null && typeof request.value !== 'string')
    ) {
      child.postMessage({
        type: 'secret:result',
        requestId: request.requestId,
        ok: false,
        error: 'Invalid secure credential mutation',
      });
      return;
    }
    try {
      secureSecretStore.set(request.key, request.value as string | null);
      child.postMessage({
        type: 'secret:result',
        requestId: request.requestId,
        ok: true,
      });
    } catch (err) {
      child.postMessage({
        type: 'secret:result',
        requestId: request.requestId,
        ok: false,
        error:
          err instanceof Error ? err.message : 'Secure secret write failed',
      });
    }
  });
  child.once('spawn', () => {
    child.postMessage({
      type: 'secret:init',
      secrets: secretSnapshot,
    });
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

  // Reset the per-fork stderr ring so a previous successful run's tail
  // can't bleed into a new crash dump.
  stderrRing = Buffer.alloc(0);

  // Always capture stderr into the ring buffer in both dev and prod —
  // it's tiny and gives us identical crash-dump behaviour everywhere.
  serverProcess.stderr?.on('data', (chunk: Buffer) => appendStderrRing(chunk));

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
  }
  // Prod: stdout is consumed by the always-on no-op drain installed
  // above; the server's own pino logger writes structured JSON to
  // `<HUABU_DATA_DIR>/logs/server.log` (see apps/server/src/utils/logger.ts),
  // so there's no need to also tee a duplicate copy to disk. On
  // non-zero exit we dump the captured stderr ring as a crash file.

  serverExitPromise = new Promise((resolve) => {
    serverProcess!.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[desktop] server exited with code ${code}`);
        dumpServerCrash(code ?? -1);
      }
      serverProcess = null;
      // `utilityProcess.fork` only forwards an exit code, never a signal
      // — keep the shape symmetric with the POSIX-style tuple anyway
      // so future swaps to child_process don't require call-site edits.
      resolve({ code: code ?? null, signal: null });
    });
  });
}

// ── Port / readiness ─────────────────────────────────────────────────

/**
 * Poll until the server port accepts a TCP connection or we time out.
 * Uses raw TCP (not HTTP) so it works before Fastify has registered routes.
 *
 * When `exitSignal` is provided we race the poll against the child's
 * exit — if the server we just forked dies first, we reject with the
 * exit code instead of waiting out the full timeout (and instead of
 * accidentally "succeeding" because some OTHER process happens to own
 * the same loopback port).
 */
function waitForPort(
  port: number,
  timeoutMs = 20_000,
  exitSignal?: Promise<{ code: number | null; signal: string | null }>,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishOk = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    if (exitSignal) {
      void exitSignal.then(({ code, signal }) => {
        finishErr(
          new Error(
            `Server process exited before becoming ready (code=${
              code ?? 'null'
            }, signal=${signal ?? 'null'})`,
          ),
        );
      });
    }

    function attempt() {
      if (settled) return;
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.destroy();
        finishOk();
      });
      socket.on('error', () => {
        socket.destroy();
        if (settled) return;
        if (Date.now() - start > timeoutMs) {
          finishErr(
            new Error(`Server did not start within ${timeoutMs / 1000}s`),
          );
          return;
        }
        setTimeout(attempt, 200);
      });
    }
    attempt();
  });
}

// ── Workspace persistence ────────────────────────────────────────────

/**
 * Persist the user-selected free-mode workspace path (and recent list)
 * in a JSON file under `app.getPath('userData')` so it survives across
 * launches independently of the renderer's `localStorage`.
 *
 * Why not just rely on `localStorage`? Chromium partitions storage by
 * origin (scheme + host + port). The Electron shell forks the server on
 * a fresh port whenever the preferred port (3001) is busy — e.g. a
 * leftover server process, another local service, or simply a second
 * launch racing with the first. A different port means a different
 * origin, which means a separate, empty `localStorage` bucket and the
 * user is dumped back on the workspace picker even though they picked
 * a folder yesterday.
 *
 * Storing the path in the main process (one location per user,
 * port-agnostic) and exposing it over IPC sidesteps the partition
 * entirely. The renderer still keeps `localStorage` writes for
 * browser/dev mode compatibility, but the Electron bridge takes
 * precedence when present.
 */

const WORKSPACE_STORE_FILE = 'workspace.json';
const MAX_RECENT_WORKSPACES = 5;

interface WorkspaceStore {
  path: string | null;
  recent: string[];
}

function workspaceStorePath(): string {
  return join(app.getPath('userData'), WORKSPACE_STORE_FILE);
}

function readWorkspaceStore(): WorkspaceStore {
  const file = workspaceStorePath();
  if (!existsSync(file)) return { path: null, recent: [] };
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { path: null, recent: [] };
    }
    const obj = parsed as Record<string, unknown>;
    const path =
      typeof obj.path === 'string' && obj.path.length > 0 ? obj.path : null;
    const recent = Array.isArray(obj.recent)
      ? obj.recent.filter((p): p is string => typeof p === 'string')
      : [];
    return { path, recent };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[desktop] workspace store unreadable: ${message}`);
    return { path: null, recent: [] };
  }
}

function writeWorkspaceStore(store: WorkspaceStore): void {
  const file = workspaceStorePath();
  // Atomic-ish write via tmp + rename so a crash mid-write doesn't
  // leave a half-truncated JSON the next launch refuses to parse.
  const tmp = `${file}.tmp`;
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  renameSync(tmp, file);
}

function pushRecentWorkspace(store: WorkspaceStore, path: string): string[] {
  const next = [path, ...store.recent.filter((p) => p !== path)].slice(
    0,
    MAX_RECENT_WORKSPACES,
  );
  return next;
}

function registerWorkspaceIpc(): void {
  ipcMain.handle('workspace:get', () => readWorkspaceStore());

  ipcMain.handle('workspace:set', (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      throw new Error('workspace:set requires a non-empty string path');
    }
    if (!isAbsolute(rawPath)) {
      throw new Error('workspace:set requires an absolute path');
    }
    const current = readWorkspaceStore();
    const next: WorkspaceStore = {
      path: rawPath,
      recent: pushRecentWorkspace(current, rawPath),
    };
    writeWorkspaceStore(next);
    return next;
  });

  ipcMain.handle('workspace:remove-recent', (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string') {
      throw new Error('workspace:remove-recent requires a string path');
    }
    const current = readWorkspaceStore();
    const next: WorkspaceStore = {
      path: current.path === rawPath ? null : current.path,
      recent: current.recent.filter((p) => p !== rawPath),
    };
    writeWorkspaceStore(next);
    return next;
  });
}

function registerWindowIpc(): void {
  ipcMain.handle('window:is-fullscreen', () => {
    return mainWindow ? mainWindow.isFullScreen() : false;
  });
}

/**
 * Desktop-only support actions exposed through the sandboxed preload bridge.
 * Paths stay in the main process: the renderer may ask Electron to reveal the
 * canonical server log, but never receives an arbitrary local filesystem path.
 */
function registerDiagnosticsIpc(): void {
  ipcMain.handle(
    'diagnostics:open-server-log',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      const configuredDataDir = process.env.HUABU_DATA_DIR?.trim();
      if (getExternalServerUrl() && !configuredDataDir) {
        return {
          ok: false,
          error:
            'The external Server did not provide its data directory. Set HUABU_DATA_DIR when launching the desktop app.',
        };
      }
      const dataDir = configuredDataDir
        ? configuredDataDir
        : join(app.getPath('userData'), 'data');
      const logsDir = join(dataDir, 'logs');
      const logFile = join(logsDir, 'server.log');
      mkdirSync(logsDir, { recursive: true });

      if (existsSync(logFile)) {
        shell.showItemInFolder(logFile);
        return { ok: true };
      }

      const error = await shell.openPath(logsDir);
      return error ? { ok: false, error } : { ok: true };
    },
  );

  ipcMain.handle(
    'diagnostics:open-developer-tools',
    (): { ok: true } | { ok: false; error: string } => {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!win || win.webContents.isDestroyed()) {
        return { ok: false, error: 'No application window is available.' };
      }
      win.webContents.openDevTools();
      return { ok: true };
    },
  );

  ipcMain.handle('diagnostics:get-system-info', () => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    osRelease: getOsRelease(),
    architecture: process.arch,
    electronVersion: process.versions.electron,
  }));
}

/**
 * Native folder-picker IPC.
 *
 * Routes the renderer's `pickFolder()` call to Electron's
 * `dialog.showOpenDialog` instead of having the Fastify server spawn
 * PowerShell + `System.Windows.Forms.FolderBrowserDialog`. Two wins:
 *
 *   - **Modern look on Windows**: Electron's openDirectory dialog is
 *     backed by the IFileOpenDialog COM API (Vista+), i.e. the same
 *     Explorer-style picker with a sidebar, breadcrumb path bar and
 *     "New folder" button that File → Open in any modern app shows.
 *     The PowerShell `FolderBrowserDialog` we used previously is the
 *     legacy SHBrowseForFolder tree control — visually XP-era.
 *   - **No PowerShell spawn per click**: faster, no shell flash, no
 *     stdout parsing.
 *
 * The result shape matches `PickFolderResult` from
 * `@sediment/shared` so the renderer can use the same branching
 * (`ok`, `reason: 'cancelled'`) it already had for the server route.
 * `'no-picker'` is impossible in Electron — we always have a GUI.
 *
 * Anchored to the focused BrowserWindow when one exists so the OS
 * draws it as a true modal child of Huabu rather than a free-floating
 * window the user can lose behind the app.
 */
function registerDialogIpc(): void {
  ipcMain.handle(
    'dialog:pick-folder',
    async (
      _event,
      rawTitle: unknown,
    ): Promise<
      { ok: true; path: string } | { ok: false; reason: 'cancelled' }
    > => {
      const title =
        typeof rawTitle === 'string' && rawTitle.length > 0
          ? rawTitle
          : undefined;
      const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const options: Electron.OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
        ...(title ? { title } : {}),
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, reason: 'cancelled' };
      }
      return { ok: true, path: result.filePaths[0] };
    },
  );
}

// ── BrowserWindow ────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

/**
 * Allow cross-origin web pages to be embedded inside our renderer's
 * `<iframe>` elements.
 *
 * Sites commonly block embedding by sending `X-Frame-Options: DENY |
 * SAMEORIGIN` or `Content-Security-Policy: frame-ancestors …`. Inside an
 * Electron desktop app these headers are over-protective: the only frame
 * we ever embed into is the user's own canvas, so we strip the embedding
 * restrictions on the response headers before Chromium enforces them.
 *
 * This is intentionally desktop-only — the plain web build runs in the
 * user's browser and cannot rewrite response headers, so its Web node
 * Preview will fall back to the Reader view when the live iframe is
 * blocked. The renderer still gets full Chromium sandboxing, contextIso-
 * lation, and `webPreferences.sandbox: true`, so a malicious embedded
 * page cannot reach into the host.
 *
 * Same-origin requests (our own `/api/*`, the SPA chunks) are filtered
 * out so we never weaken our own security headers.
 */
function configureWebSession(serverOrigin: string): void {
  const filter = { urls: ['<all_urls>'] };
  session.defaultSession.webRequest.onHeadersReceived(
    filter,
    (details, callback) => {
      // Leave our own origin alone — stripping CSP from our SPA would be
      // a self-inflicted XSS expansion. Match the runtime origin so HMR
      // dev servers and the loopback server are both covered.
      if (details.url.startsWith(serverOrigin)) {
        callback({});
        return;
      }

      const headers: Record<string, string[] | string> = {};
      for (const [name, value] of Object.entries(
        details.responseHeaders ?? {},
      )) {
        const lower = name.toLowerCase();
        if (lower === 'x-frame-options') continue;
        if (lower === 'content-security-policy') {
          const values = Array.isArray(value) ? value : [value];
          const cleaned = values
            .map((v) => v.replace(/frame-ancestors[^;]*;?/gi, '').trim())
            .filter((v) => v.length > 0);
          if (cleaned.length > 0) headers[name] = cleaned;
          continue;
        }
        headers[name] = value as string | string[];
      }
      callback({ responseHeaders: headers });
    },
  );
}

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

  const sendFullScreen = (fullScreen: boolean): void => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window:fullscreen', fullScreen);
    }
  };
  mainWindow.on('enter-full-screen', () => sendFullScreen(true));
  mainWindow.on('leave-full-screen', () => sendFullScreen(false));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App lifecycle ────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Per-platform application menu. macOS gets a native menu bar (the
  // platform-conventional home for workspace-level actions); Windows /
  // Linux keep it cleared and rely on the custom title bar's `AppMenu`
  // dropdown instead. The menu is built with English fallback labels
  // here so the standard Edit / Window accelerators and ⌘, / ⌘N work
  // from the first frame; the renderer re-pushes localized labels via
  // `menu:configure` once i18n is ready. Chromium still wires up the
  // usual editing keyboard accelerators, and our DevTools / reload
  // accelerators are re-bound per window via `before-input-event`
  // inside `createWindow`.
  applyApplicationMenu(() => mainWindow);

  // Register IPC handlers BEFORE any window is created so the preload
  // script's `ipcRenderer.invoke('workspace:get', …)` calls always have
  // a handler to talk to, even on the very first render.
  registerWorkspaceIpc();
  registerWindowIpc();
  registerDiagnosticsIpc();
  registerDialogIpc();
  registerMenuIpc(() => mainWindow);

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
    const external = getExternalServerUrl();
    if (!external) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          'Operating-system credential encryption is unavailable.',
        );
      }
      if (
        process.platform === 'linux' &&
        safeStorage.getSelectedStorageBackend() === 'basic_text'
      ) {
        throw new Error(
          'A Linux Secret Service or KWallet backend is required to protect credentials.',
        );
      }
      const probe = `huabu-safe-storage-probe-${Date.now()}`;
      if (
        safeStorage.decryptString(safeStorage.encryptString(probe)) !== probe
      ) {
        throw new Error(
          'Operating-system credential encryption verification failed.',
        );
      }
      const dataDir = join(app.getPath('userData'), 'data');
      secureSecretStore = new DesktopSecureSecretStore(dataDir, safeStorage);
      secureSecretStore.migratePlaintextFiles();
    }

    // Augment PATH from the user's login shell BEFORE forking the
    // server so host-CLI detection (`which copilot` / `claude` /
    // `gemini`) sees the same entries the user has in their Terminal.
    // See `ensureShellPath` for rationale.
    await ensureShellPath();

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
      // Race-resistant port allocation: `get-port` only tells us the
      // port was free *at the moment we asked*. Between then and the
      // server's `app.listen()` another process can grab it (a stale
      // Huabu install, a leftover dev orchestrator, an unrelated
      // service that just bound 3001). When that happens the child
      // crashes with EADDRINUSE — retry with a fresh port instead of
      // surfacing the error to the user.
      const tried = new Set<number>();
      let lastErr: Error | null = null;
      for (let attempt = 1; attempt <= MAX_SERVER_START_ATTEMPTS; attempt++) {
        // Bias the first attempt toward 3001 for stable origins
        // (localStorage, OAuth callback URLs, etc.); subsequent
        // attempts ask for any free port and exclude what we already
        // tried so we never re-pick the loser.
        const candidate = await getPort({
          port: attempt === 1 ? PREFERRED_PORT : undefined,
          exclude: [...tried],
        });
        tried.add(candidate);
        try {
          await startServer(candidate);
          await waitForPort(candidate, 20_000, serverExitPromise ?? undefined);
          serverPort = candidate;
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          console.warn(
            `[desktop] server start attempt ${attempt}/${MAX_SERVER_START_ATTEMPTS} on port ${candidate} failed: ${lastErr.message}`,
          );
          // Best-effort cleanup: if the child is somehow still alive
          // (waitForPort timeout rather than early exit), kill it so
          // the next attempt doesn't leak a zombie.
          if (serverProcess) {
            try {
              serverProcess.kill();
            } catch {
              /* already dead */
            }
            serverProcess = null;
          }
        }
      }
      if (lastErr) throw lastErr;
    }
    const devServerUrl = process.env.WEB_DEV_SERVER_URL;
    const serverOrigin =
      IS_DEV && devServerUrl ? devServerUrl : `http://127.0.0.1:${serverPort}`;
    configureWebSession(serverOrigin);
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
//   1. ask the server to shut down cooperatively so it runs Fastify's
//      `onClose` hooks (reap the agentlet daemon, close the external-note
//      chokidar watch handle, flush logs). On Windows `serverProcess.kill()`
//      is a hard `TerminateProcess` that bypasses the server's signal
//      handlers, so a `system:shutdown` message over the utility parent
//      port is the ONLY way those hooks run before exit — otherwise the
//      Google Drive watch handle is force-abandoned and can stay wedged;
//   2. wait for the server to actually exit (its `'exit'` handler also
//      closes the rotating log stream — racing past it loses the last
//      few KB of buffered logs); and
//   3. enforce a hard cap so a hung server can never block quit. 3s is
//      generous: the cooperative path completes in well under a second on
//      a healthy machine, and a wedged filesystem still exits via the
//      hard `kill()` fallback below.
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
  // Prefer a cooperative shutdown so the server's `onClose` hooks run.
  try {
    proc.postMessage({ type: 'system:shutdown' });
  } catch {
    // No parent-port channel (shouldn't happen for a utilityProcess) —
    // fall straight through to the hard kill below.
  }
  // Fallback if the cooperative shutdown doesn't land in time (e.g. the
  // message handler never registered, or the event loop is wedged). On
  // Windows `proc.kill()` is a hard `TerminateProcess`; on POSIX it is a
  // SIGTERM, which the server handles as *another* graceful shutdown, so
  // the only truly forceful stop there is the `app.exit(0)` cap below.
  // 2.5s (under the 3s app.exit cap) gives `app.close()` — which closes
  // the chokidar watch handle this fix protects — headroom to finish
  // before Windows force-terminates it mid-cleanup.
  const hardKill = setTimeout(() => {
    if (!exited) {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    }
  }, 2500);
  hardKill.unref?.();
  setTimeout(() => {
    if (!exited) {
      console.warn(
        '[desktop] server did not exit within 3s of shutdown request; forcing app.exit',
      );
      app.exit(0);
    }
  }, 3000);
});

// Terminal-launched dev runs (`pnpm start:desktop`) deliver SIGINT on
// Ctrl+C / SIGTERM when the parent orchestrator tears down. Electron
// does not reliably translate these into the graceful quit lifecycle,
// so without an explicit bridge the main process can die abruptly —
// skipping `before-quit` and leaking the forked server (and the
// agentlet daemon it forks in turn). Routing both signals through
// `app.quit()` guarantees the `before-quit` handler above runs and
// reaps the server subtree. `once` so a second Ctrl+C (if the graceful
// path stalls) falls through to Node's default hard-terminate.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`[desktop] received ${signal}; quitting`);
    app.quit();
  });
}
