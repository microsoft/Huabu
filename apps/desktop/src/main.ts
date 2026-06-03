/**
 * Sediment Electron main process.
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
 */

import { existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

import { app, BrowserWindow, dialog, shell } from 'electron';
import { utilityProcess, type UtilityProcess } from 'electron';
import getPort from 'get-port';

// ── Constants ────────────────────────────────────────────────────────

const IS_DEV = !app.isPackaged;
const PREFERRED_PORT = 3001;

// Last-resort safety net: log EIO/EPIPE on stdio so the main process
// doesn't die silently when its parent terminal closes. Anything else
// still surfaces via Electron's default crash dialog.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err && (err.code === 'EIO' || err.code === 'EPIPE')) {
    return;
  }
  throw err;
});

// ── Server process ───────────────────────────────────────────────────

let serverProcess: UtilityProcess | null = null;
let serverPort = 0;

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
  const agentletPath = IS_DEV
    ? join(__dirname, '../../../../bin/agentlet')
    : join(process.resourcesPath, 'agentlet');

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
  return {
    ...process.env,
    SERVER_PORT: String(port),
    HUABU_BIND_HOST: '127.0.0.1',
    HUABU_DATA_DIR: dataDir,
    ...(webDistPath ? { WEB_DIST_PATH: webDistPath } : {}),
    HUABU_AGENTLET_PATH: agentletPath,
    NODE_ENV: IS_DEV ? 'development' : 'production',
  };
}

async function startServer(port: number): Promise<void> {
  const serverEntry = resolveServerEntry();

  if (!existsSync(serverEntry)) {
    await dialog.showErrorBox(
      'Sediment — Server not found',
      `Could not find the server bundle at:\n${serverEntry}\n\nPlease rebuild the project (pnpm --filter @sediment/server build).`,
    );
    app.quit();
    return;
  }

  serverProcess = utilityProcess.fork(serverEntry, [], {
    serviceName: 'sediment-server',
    env: buildServerEnv(port),
    // Pipe stdout/stderr so we can forward to DevTools console in dev.
    stdio: 'pipe',
  });

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
    serverProcess.stdout?.on('error', () => {});
    serverProcess.stderr?.on('error', () => {});
    serverProcess.stdout?.on('data', (chunk: Buffer) =>
      safeWrite(process.stdout, '[server]', chunk),
    );
    serverProcess.stderr?.on('data', (chunk: Buffer) =>
      safeWrite(process.stderr, '[server]', chunk),
    );
  }

  serverProcess.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[desktop] server exited with code ${code}`);
    }
    serverProcess = null;
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
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Sediment',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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

  if (IS_DEV) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App lifecycle ────────────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    serverPort = await getPort({ port: PREFERRED_PORT });
    await startServer(serverPort);
    await waitForPort(serverPort);
    createWindow(serverPort);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await dialog.showErrorBox('Sediment failed to start', message);
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

// Gracefully shut down the server before the process exits.
app.on('before-quit', () => {
  serverProcess?.kill();
});
