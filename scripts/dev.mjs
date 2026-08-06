#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Dev orchestrator.
 *
 * Starts `shared` (tsc -w) and `server` in parallel, polls the Server TCP port
 * until it accepts connections, then starts `web`. This avoids the cold-start
 * window where Vite is already proxying `/api/*` while the server is still
 * booting (which surfaces as harmless but noisy ECONNREFUSED logs).
 *
 * Environment resolution mirrors apps/web/vite.config.ts:
 *   process.env  >  apps/web/.env  >  <repo-root>/.env
 * Each preferred port (server, web) is then probed with findAvailablePort
 * and slid to the next free one if occupied, and the resolved ports are
 * injected into every consumer so the Vite proxy target stays in sync with
 * wherever each service actually bound.
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { spawnSupervisedDevChild } from './dev-child-supervisor.mjs';
import { findAvailablePort } from './dev-ports.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/**
 * Parse `.env` files into a plain object without touching `process.env`.
 * We use the same `dotenv` parser as the server (apps/server/src/load-env.ts)
 * and Vite (`loadEnv`), so multi-line values, quoting and comments behave
 * identically across all three entry points.
 *
 * Files are read in lowest-to-highest precedence; later keys win.
 */
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
  // Real `process.env` always wins (CLI overrides like
  // `SERVER_PORT=4000 pnpm dev` must not be shadowed by .env files).
  return { ...merged, ...process.env };
}

const env = loadEnv(
  path.join(repoRoot, '.env'),
  path.join(repoRoot, 'apps/web/.env'),
);

const SERVER_PORT = Number.parseInt(env.SERVER_PORT || env.PORT || '3001', 10);
const WEB_PORT = Number.parseInt(env.WEB_PORT || env.VITE_PORT || '5173', 10);
const SERVER_HOST = '127.0.0.1';
const HANDBOOK_URL =
  env.VITE_HANDBOOK_URL || 'https://microsoft.github.io/Huabu/docs/';
// How long to wait for the server to accept connections before giving up.
// Cold starts (first tsx/esbuild compile, Windows Defender scanning a fresh
// node_modules, or a loaded machine) can blow past a tight window, so the
// default is generous and overridable via DEV_SERVER_READY_TIMEOUT_MS.
const READY_TIMEOUT_MS = Number.parseInt(
  env.DEV_SERVER_READY_TIMEOUT_MS || '120000',
  10,
);
const POLL_INTERVAL_MS = 250;
// Emit a "still waiting" heartbeat at this cadence so a slow boot is visible
// instead of looking hung until the timeout fires.
const WAIT_LOG_INTERVAL_MS = 10_000;

/** Resolve once the TCP port accepts a connection. Rejects on timeout. */
function waitForPort(host, port, timeoutMs) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let lastLog = start;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect({ host, port });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        const now = Date.now();
        if (now > deadline) {
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for ${host}:${port}`,
            ),
          );
          return;
        }
        if (now - lastLog >= WAIT_LOG_INTERVAL_MS) {
          lastLog = now;
          console.log(
            `[dev] still waiting for ${host}:${port} … ${Math.round(
              (now - start) / 1000,
            )}s elapsed (timeout ${Math.round(timeoutMs / 1000)}s, override with DEV_SERVER_READY_TIMEOUT_MS)`,
          );
        }
        setTimeout(tryOnce, POLL_INTERVAL_MS);
      });
    };
    tryOnce();
  });
}

const children = [];
let shuttingDown = false;

/**
 * Signal a service supervisor. The supervisor owns the nested
 * `pnpm --filter X dev` process group and reaps it before exiting.
 *
 * On POSIX each supervisor has its own process group, so `kill(-pid)`
 * reliably reaches it. On Windows we fall back to `taskkill /T`.
 *
 * On Windows the call is **synchronous** (`spawnSync`): `Ctrl+C` is
 * broadcast by the console to every attached process, so the `cmd.exe`
 * wrappers around each `pnpm.cmd` shim would normally race to print the
 * dreaded "Terminate batch job (Y/N)?" prompt. By blocking until
 * `taskkill /F /T` returns we make sure the whole subtree is gone
 * before `process.exit` runs and before cmd.exe gets a chance to render
 * that prompt on the shared terminal.
 */
function killTree(child, signal) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Process group may already be gone — fall back to direct kill.
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
  // On Windows `killTree` already ran `taskkill /F /T` synchronously, so
  // the whole tree is gone — no SIGKILL escalation is meaningful (SIGKILL
  // doesn't even exist on Win32; the old second pass was dead code that
  // also delayed exit by ~1s and gave cmd.exe a window to print the
  // "Terminate batch job (Y/N)?" prompt on the shared terminal).
  if (process.platform === 'win32') {
    process.exit(code);
    return;
  }
  // POSIX: give children a moment to exit cleanly, then escalate to
  // SIGKILL for any stragglers before we exit ourselves.
  setTimeout(() => {
    for (const child of children) {
      killTree(child, 'SIGKILL');
    }
    process.exit(code);
  }, 1000);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/**
 * Belt-and-suspenders Ctrl+C handler for Windows.
 *
 * On Windows, `Ctrl+C` is only translated into a `SIGINT` for our process
 * while the console's `ENABLE_PROCESSED_INPUT` flag is set. Any child that
 * puts stdin into raw mode (tsx watch, vite, etc.) clears that flag for the
 * whole console — from then on `Ctrl+C` arrives as a plain `0x03` byte on
 * stdin instead of a `CTRL_C_EVENT`, and our `SIGINT` handler never fires.
 *
 * We mitigate this two ways:
 *   1. Children are spawned with `stdio: ['ignore', 'inherit', 'inherit']`
 *      so they can't grab stdin and flip the console mode in the first
 *      place (see `spawnPnpmDev` / `spawnAgentletWatch`).
 *   2. We also flip our *own* stdin into raw mode and watch for the `0x03`
 *      byte directly, so even if something still manages to suppress
 *      `CTRL_C_EVENT`, the keystroke reaches us and triggers `shutdown`.
 *
 * The tradeoff is that vite/tsx interactive keys (`r` / `h` / `q` / etc.)
 * no longer reach those tools — acceptable, since the dev loop is driven
 * by file watchers and the browser, not by terminal keypresses.
 */
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (buf) => {
      // 0x03 = Ctrl+C, 0x04 = Ctrl+D — either should tear the orchestrator
      // down. Everything else is intentionally discarded.
      for (const byte of buf) {
        if (byte === 0x03 || byte === 0x04) {
          shutdown(0);
          return;
        }
      }
    });
    // Restore the terminal so the user's shell prompt isn't left in raw
    // mode after we exit (otherwise their next command echoes weirdly).
    process.on('exit', () => {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    });
  } catch {
    // Non-fatal: if raw mode isn't available we still have the SIGINT
    // handler above, which is enough on POSIX and on Windows consoles
    // where no child has flipped ENABLE_PROCESSED_INPUT.
  }
}

/** Spawn a `pnpm --filter <pkg> dev` child wired to our stdio. */
function spawnPnpmDev(filter, label, extraEnv = {}) {
  const child = spawnSupervisedDevChild({
    command: 'pnpm',
    args: ['--filter', filter, 'dev'],
    cwd: repoRoot,
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[dev] ${label} exited (code=${code} signal=${signal}); shutting down.`,
    );
    shutdown(code ?? 1);
  });
  return child;
}

/**
 * Spawn `tsc -w` inside a vendored agentlet package (`external/agentlet/...`).
 *
 * Those packages have no `dev` script of their own — we don't want to patch
 * vendored code — so we invoke their local `tsc` via `pnpm exec`. The
 * resulting `dist/` is what `apps/server`'s `tsx watch` actually imports
 * through `node_modules/@agentlet/*` symlinks, so any source change here
 * propagates to a server restart automatically.
 *
 * `predev` (`build:agentlet`) primes `dist/` before this runs, so the server
 * never races a still-empty `dist/` on cold start.
 */
function spawnAgentletWatch(filter, label) {
  const child = spawnSupervisedDevChild({
    command: 'pnpm',
    args: ['--filter', filter, 'exec', 'tsc', '-w', '--preserveWatchOutput'],
    cwd: repoRoot,
    shell: process.platform === 'win32',
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[dev] ${label} exited (code=${code} signal=${signal}); shutting down.`,
    );
    shutdown(code ?? 1);
  });
  return child;
}

// Resolve actually-free ports before spawning anything (mirrors
// scripts/dev-desktop.mjs). If a stale server/vite is still holding the
// preferred port, slide to the next free one instead of crashing the
// server or letting Vite's strictPort abort — and propagate the resolved
// ports to every consumer so the Vite proxy target stays in sync with
// wherever each service actually bound.
const serverPort = await findAvailablePort(SERVER_PORT);
if (serverPort !== SERVER_PORT) {
  console.warn(
    `[dev] Server port ${SERVER_PORT} is in use; using ${serverPort} instead.`,
  );
}
const webPort = await findAvailablePort(WEB_PORT, new Set([serverPort]));
if (webPort !== WEB_PORT) {
  console.warn(
    `[dev] Web port ${WEB_PORT} is in use or reserved; using ${webPort} instead.`,
  );
}

console.log('[dev] starting agentlet watcher + shared + server …');
// `predev` already populated protocol dist; this watcher keeps it current for
// the daemon bundle and Agenetes Gateway consumers during development.
spawnAgentletWatch('@agentlet/protocol', 'agentlet/protocol');
spawnPnpmDev('@huabu/shared', 'shared');
spawnPnpmDev('@huabu/server', 'server', {
  SERVER_PORT: String(serverPort),
});

try {
  await waitForPort(SERVER_HOST, serverPort, READY_TIMEOUT_MS);
  console.log(
    `[dev] server is up at http://${SERVER_HOST}:${serverPort}; starting web on :${webPort} …`,
  );
  // Pass the resolved ports through env so vite.config.ts binds the port we
  // already probed as free (its strictPort would otherwise abort) and its
  // `/api/*` proxy target follows the server wherever it actually bound.
  spawnPnpmDev('@huabu/web', 'web', {
    SERVER_PORT: String(serverPort),
    WEB_PORT: String(webPort),
    VITE_PORT: String(webPort),
    VITE_HANDBOOK_URL: HANDBOOK_URL,
  });
} catch (err) {
  console.error('[dev]', err);
  shutdown(1);
}
