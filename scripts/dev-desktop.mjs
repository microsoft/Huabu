#!/usr/bin/env node
/**
 * Dev orchestrator for the Electron desktop shell with full-stack HMR.
 *
 * What you get when running `pnpm dev:desktop`:
 *   - `apps/web/src/**`                       → Vite HMR (instant)
 *   - `apps/server/src/**`                    → `tsx watch` auto-restart
 *   - `packages/shared/src/**`                → propagates to BOTH
 *     (web reads source through Vite; server picks it up via `tsx watch`
 *     because shared's `package.json` points `main` at `src/index.ts`)
 *   - `apps/desktop/src/**` (main / preload)  → requires re-running this
 *     script; Electron only loads main.js once at startup.
 *
 * How it works:
 *   1. Spawn `pnpm dev:shared` (tsc -w) — harmless duplicate of what Vite
 *      already does for the web side, but it keeps `packages/shared/dist`
 *      fresh in case anything else consumes it.
 *      (Currently nothing does in dev mode, so we skip it to avoid noise.)
 *   2. Spawn `pnpm dev:server` (`tsx watch src/server.ts`). This is a
 *      long-running Node process bound on SERVER_PORT (default 3001),
 *      and it auto-restarts on changes to any imported file.
 *   3. Spawn `pnpm dev:web` (Vite) for the web HMR side.
 *   4. Wait for both ports to accept TCP connections.
 *   5. Launch Electron with two env vars wired in:
 *        WEB_DEV_SERVER_URL  → tells main.ts to loadURL the Vite server
 *        EXTERNAL_SERVER_URL → tells main.ts to SKIP forking the bundled
 *                              server and use the external one instead
 *      Without `EXTERNAL_SERVER_URL`, main.ts would race the orchestrated
 *      server for the same SERVER_PORT.
 *   6. SIGINT/SIGTERM cascade: when any child dies (Electron close,
 *      Ctrl+C, Vite crash) we tear the others down so no Node/Vite/tsx
 *      processes are orphaned.
 *
 * Caveats:
 *   - When the server auto-restarts (post tsx detection), open SSE / WS
 *     streams in the renderer drop. Most HTTP request/response flows
 *     just retry on the next user action; ACP / chat streams may need
 *     the page reloaded (Ctrl+R) once.
 *   - If you change `apps/desktop/src/**`, re-run this script. There is
 *     no clean way to hot-swap Electron's main process.
 *
 * Port resolution mirrors `apps/web/vite.config.ts` and `scripts/dev.mjs`:
 *   process.env  >  apps/web/.env  >  <repo-root>/.env  >  defaults
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/* ─── env loading (same precedence as scripts/dev.mjs) ────────────── */

function loadEnv(...files) {
  const merged = {};
  for (const file of files) {
    const parsed = dotenv.config({
      path: file,
      processEnv: {},
      quiet: true,
    }).parsed;
    if (parsed) Object.assign(merged, parsed);
  }
  return { ...merged, ...process.env };
}

const env = loadEnv(
  path.join(repoRoot, '.env'),
  path.join(repoRoot, 'apps/web/.env'),
);

const HOST = '127.0.0.1';
const SERVER_PORT = Number.parseInt(env.SERVER_PORT || env.PORT || '3001', 10);
const VITE_PORT = Number.parseInt(env.VITE_PORT || env.WEB_PORT || '5173', 10);
const PORT_SCAN_RANGE = 50;
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;

/* ─── helpers ─────────────────────────────────────────────────────── */

/**
 * Probe whether `host:port` can accept a fresh `listen()`. This is the
 * same check Fastify / Vite will do at startup, so a `true` here means
 * the next spawned child should be able to bind without EADDRINUSE.
 *
 * TOCTOU caveat: between this check and the child's actual `listen()`
 * another process could grab the port. In a dev orchestrator that's
 * vanishingly rare and not worth a retry loop downstream.
 */
function isPortFree(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

/**
 * Find a free port starting at `startPort`, scanning at most
 * `PORT_SCAN_RANGE` consecutive ports. Used so a stale Electron / tsx
 * holding 3001 (or 5173) doesn't crash the whole orchestrator — we
 * just slide to 3002 / 5174 and propagate that everywhere.
 */
async function findAvailablePort(host, startPort) {
  for (let p = startPort; p < startPort + PORT_SCAN_RANGE; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(host, p)) return p;
  }
  throw new Error(
    `No free port found in ${startPort}..${startPort + PORT_SCAN_RANGE - 1} on ${host}`,
  );
}

function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect({ host, port });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for ${host}:${port}`,
            ),
          );
          return;
        }
        setTimeout(tryOnce, POLL_INTERVAL_MS);
      });
    };
    tryOnce();
  });
}

/** Run a command synchronously to completion, inheriting stdio. */
function runStep(label, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[dev-desktop] ${label}`);
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: true,
      cwd: repoRoot,
      ...opts,
    });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.once('error', reject);
  });
}

/* ─── process-group lifecycle (mirrors scripts/dev.mjs) ───────────── */

const children = [];
let shuttingDown = false;

/**
 * Kill a child *and its descendants*. `pnpm --filter X dev` spawns nested
 * processes (node → tsx watch / vite); a plain `child.kill('SIGTERM')`
 * only reaches the pnpm wrapper and orphans tsx / vite (which keep ports
 * busy on next run).
 *
 * On POSIX we put each child in its own process group (`detached: true`)
 * and signal the whole group with `kill(-pid)`. On Windows we fall back
 * to `taskkill /T` to walk the process tree.
 */
function killTree(child, signal) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {
      /* best-effort */
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    killTree(child, 'SIGTERM');
  }
  setTimeout(() => {
    for (const child of children) {
      killTree(child, 'SIGKILL');
    }
    process.exit(code);
  }, 1000);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** Spawn a long-running pnpm dev child, tracked for shutdown. */
function spawnLongRunning(filter, label, extraEnv = {}) {
  const child = spawn('pnpm', ['--filter', filter, 'dev'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[dev-desktop] ${label} exited (code=${code} signal=${signal}); shutting down.`,
    );
    shutdown(code ?? 1);
  });
  return child;
}

/* ─── main ────────────────────────────────────────────────────────── */

async function main() {
  // 1. Prime Electron's main/preload output. tsc is fast on incremental
  //    builds; the only reason to run it every time is that changes to
  //    these files require re-running the orchestrator anyway, so a
  //    fresh build is what the user expects when they kick this off.
  await runStep('Compiling @sediment/desktop (main + preload)', 'pnpm', [
    '--filter',
    '@sediment/desktop',
    'build',
  ]);

  // 1b. Resolve actually-free ports before spawning. If a stale Electron
  //     / tsx is still holding 3001 (or someone else owns 5173), slide
  //     to the next free port instead of crashing the orchestrator —
  //     and propagate that port to every consumer below so the Vite
  //     proxy and Electron's EXTERNAL_SERVER_URL stay in sync with
  //     wherever the server actually bound.
  const serverPort = await findAvailablePort(HOST, SERVER_PORT);
  if (serverPort !== SERVER_PORT) {
    console.warn(
      `[dev-desktop] Server port ${SERVER_PORT} is in use; using ${serverPort} instead.`,
    );
  }
  const vitePort = await findAvailablePort(HOST, VITE_PORT);
  if (vitePort !== VITE_PORT) {
    console.warn(
      `[dev-desktop] Vite port ${VITE_PORT} is in use; using ${vitePort} instead.`,
    );
  }

  // 2. Start the watch-mode server (tsx watch). This auto-restarts on
  //    changes to apps/server/src/** AND packages/shared/src/** because
  //    shared's package main points at src/index.ts — tsx tracks imports
  //    and reloads the whole entry on any tracked file change.
  console.log(
    `[dev-desktop] Starting @sediment/server (tsx watch) on :${serverPort} …`,
  );
  spawnLongRunning('@sediment/server', 'server', {
    SERVER_PORT: String(serverPort),
    HUABU_BIND_HOST: HOST,
  });

  // 3. Start Vite in parallel. SPA fetches to `/api/*` will be proxied
  //    by Vite to SERVER_PORT, so both watchers must live on the same
  //    port pair the rest of the dev tooling expects. We pass the
  //    resolved ports through env so vite.config.ts's proxy target
  //    follows the server, and Vite itself binds the port we already
  //    probed as free (avoids Vite silently picking yet another port
  //    via its default strictPort:false fallback).
  console.log(`[dev-desktop] Starting @sediment/web (Vite) on :${vitePort} …`);
  spawnLongRunning('@sediment/web', 'web', {
    SERVER_PORT: String(serverPort),
    WEB_PORT: String(vitePort),
    VITE_PORT: String(vitePort),
  });

  // 4. Wait for both to actually accept TCP connections before launching
  //    Electron, so the first page load never sees a 502/ECONNREFUSED.
  try {
    await Promise.all([
      waitForPort(HOST, serverPort, READY_TIMEOUT_MS),
      waitForPort(HOST, vitePort, READY_TIMEOUT_MS),
    ]);
  } catch (err) {
    console.error(`[dev-desktop] ${err.message}`);
    shutdown(1);
    return;
  }
  console.log(
    `[dev-desktop] server up at http://${HOST}:${serverPort}, vite up at http://${HOST}:${vitePort}`,
  );

  // 5. Launch Electron, telling main.ts to (a) load the Vite URL into
  //    the BrowserWindow and (b) NOT fork its own server — point at the
  //    orchestrated one via EXTERNAL_SERVER_URL.
  const electronEnv = {
    ...process.env,
    WEB_DEV_SERVER_URL: `http://${HOST}:${vitePort}`,
    EXTERNAL_SERVER_URL: `http://${HOST}:${serverPort}`,
  };
  // VS Code's task terminal sometimes leaks this and it would make
  // `electron .` run as a plain Node process instead of an Electron app.
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  console.log('[dev-desktop] Launching Electron …');
  const electron = spawn('pnpm', ['exec', 'electron', '.'], {
    stdio: 'inherit',
    shell: true,
    cwd: path.join(repoRoot, 'apps/desktop'),
    env: electronEnv,
    detached: process.platform !== 'win32',
  });
  children.push(electron);
  electron.once('exit', (code) => {
    // User closed the Electron window → tear down server + vite too.
    shutdown(code ?? 0);
  });
}

// Note for future contributors: shared's package main points at
// src/index.ts, so neither web (via Vite) nor server (via tsx) reads
// from packages/shared/dist in dev mode — no build-shared step is
// needed here. If you ever flip shared back to a built artifact, add a
// one-shot `pnpm --filter @sediment/shared build` before the watchers.

main().catch((err) => {
  console.error('[dev-desktop]', err);
  shutdown(1);
});
