#!/usr/bin/env node
/**
 * Dev orchestrator.
 *
 * Starts `shared` (tsc -w) and `server` in parallel, polls the backend TCP
 * port until it accepts connections, then starts `web`. This avoids the
 * cold-start window where Vite is already proxying `/api/*` while the server
 * is still booting (which surfaces as harmless but noisy ECONNREFUSED logs).
 *
 * Port resolution mirrors apps/web/vite.config.ts:
 *   process.env  >  apps/web/.env  >  <repo-root>/.env
 * but we only need SERVER_PORT / PORT here.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

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
const SERVER_HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;

/** Resolve once the TCP port accepts a connection. Rejects on timeout. */
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

const children = [];
let shuttingDown = false;

/**
 * Kill a child *and its descendants*. `pnpm --filter X dev` spawns nested
 * processes (node → tsc -w / vite); a plain `child.kill('SIGTERM')` only
 * reaches the pnpm wrapper and orphans tsc / vite (which keep ports busy).
 *
 * On POSIX we put each child in its own process group (`detached: true` +
 * `setsid`) and signal the whole group with `kill(-pid)`. On Windows we
 * fall back to `taskkill /T` to walk the process tree.
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
  // Give children a moment to exit cleanly, then escalate to SIGKILL
  // for any stragglers before we exit ourselves.
  setTimeout(() => {
    for (const child of children) {
      killTree(child, 'SIGKILL');
    }
    process.exit(code);
  }, 1000);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** Spawn a `pnpm --filter <pkg> dev` child wired to our stdio. */
function spawnPnpmDev(filter, label) {
  const child = spawn('pnpm', ['--filter', filter, 'dev'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // POSIX: own process group so we can signal the whole subtree.
    detached: process.platform !== 'win32',
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
  const child = spawn(
    'pnpm',
    ['--filter', filter, 'exec', 'tsc', '-w', '--preserveWatchOutput'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
    },
  );
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

console.log('[dev] starting agentlet watchers + shared + server …');
// Order within the parallel group doesn't matter — agentlet/protocol is a
// build-time dep of agentlet/server, but `predev` already ran a full build
// so both watchers start from a populated `dist/` and only do incremental
// recompiles from here on.
spawnAgentletWatch('@agentlet/protocol', 'agentlet/protocol');
spawnAgentletWatch('@agentlet/server', 'agentlet/server');
spawnPnpmDev('@sediment/shared', 'shared');
spawnPnpmDev('@sediment/server', 'server');

try {
  await waitForPort(SERVER_HOST, SERVER_PORT, READY_TIMEOUT_MS);
  console.log(
    `[dev] server is up at ${SERVER_HOST}:${SERVER_PORT}; starting web …`,
  );
  spawnPnpmDev('@sediment/web', 'web');
} catch (err) {
  console.error('[dev]', err);
  shutdown(1);
}
