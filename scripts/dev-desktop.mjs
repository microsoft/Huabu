#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
 *   3. Spawn `pnpm dev:web` (Vite) for the web HMR side, injecting the
 *      configured or public handbook URL through VITE_HANDBOOK_URL.
 *   4. Wait for the Server and web ports to accept TCP connections.
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
 * Server/web port resolution mirrors `apps/web/vite.config.ts` and
 * `scripts/dev.mjs`:
 *   process.env  >  apps/web/.env  >  <repo-root>/.env  >  defaults
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { spawnSupervisedDevChild } from './dev-child-supervisor.mjs';
import { findAvailablePort } from './dev-ports.mjs';

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
const HANDBOOK_URL =
  env.VITE_HANDBOOK_URL || 'https://microsoft.github.io/Huabu/docs/';
// Cold starts (first tsx/esbuild compile, Windows Defender scanning a fresh
// node_modules, or a loaded machine) can blow past a tight window, so the
// default is generous and overridable via DEV_SERVER_READY_TIMEOUT_MS.
// Server + Vite cold-compile in parallel here, so on Windows the server's
// first tsx/esbuild compile has been observed landing right on the old 120s
// edge — 180s leaves headroom without masking a genuine hang.
const READY_TIMEOUT_MS = Number.parseInt(
  env.DEV_SERVER_READY_TIMEOUT_MS || '180000',
  10,
);
const POLL_INTERVAL_MS = 250;
// Emit a "still waiting" heartbeat at this cadence so a slow boot is visible
// instead of looking hung until the timeout fires.
const WAIT_LOG_INTERVAL_MS = 10_000;

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
            `[dev-desktop] still waiting for ${host}:${port} … ${Math.round(
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
 * Signal a service supervisor. The supervisor owns the nested
 * `pnpm --filter X dev` process group and reaps it before exiting.
 *
 * On POSIX each supervisor has its own process group, so `kill(-pid)`
 * reliably reaches it. On Windows we fall back to `taskkill /T`.
 *
 * On Windows the call is **synchronous** (`spawnSync`): `Ctrl+C` is
 * broadcast by the console to every attached process, so the `cmd.exe`
 * wrappers around each `pnpm.cmd` shim would normally race to print the
 * dreaded "Terminate batch job (Y/N)?" prompt. Blocking until
 * `taskkill /F /T` returns guarantees the whole subtree is gone before
 * `process.exit` runs and before cmd.exe can render that prompt on the
 * shared terminal.
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
  // also delayed exit by ~1s and let cmd.exe print the "Terminate batch
  // job (Y/N)?" prompt on the shared terminal).
  if (process.platform === 'win32') {
    process.exit(code);
    return;
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

/**
 * Belt-and-suspenders Ctrl+C handler for Windows.
 *
 * `Ctrl+C` is only translated into a `SIGINT` for our process while the
 * console's `ENABLE_PROCESSED_INPUT` flag is set. Any child that puts
 * stdin into raw mode (tsx watch, vite, Electron, etc.) clears that flag
 * for the whole console — from then on `Ctrl+C` arrives as a plain `0x03`
 * byte on stdin instead of a `CTRL_C_EVENT`, and our `SIGINT` handler
 * never fires.
 *
 * Mitigations:
 *   1. Long-running children are spawned with
 *      `stdio: ['ignore', 'inherit', 'inherit']` so they can't grab stdin
 *      and flip the console mode in the first place.
 *   2. We also flip our *own* stdin into raw mode and watch for `0x03`
 *      directly, so even if something still manages to suppress
 *      `CTRL_C_EVENT`, the keystroke reaches us and triggers `shutdown`.
 *
 * Tradeoff: vite/tsx interactive keys (`r`/`h`/`q`/etc.) no longer work,
 * which is fine for this orchestrator — the dev loop is driven by file
 * watchers and the Electron window.
 */
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (buf) => {
      for (const byte of buf) {
        // 0x03 = Ctrl+C, 0x04 = Ctrl+D — either tears the orchestrator down.
        if (byte === 0x03 || byte === 0x04) {
          shutdown(0);
          return;
        }
      }
    });
    process.on('exit', () => {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* Non-fatal: SIGINT handler above still covers non-raw cases. */
  }
}

/** Spawn a long-running pnpm dev child, tracked for shutdown. */
function spawnLongRunning(filter, label, extraEnv = {}) {
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
      `[dev-desktop] ${label} exited (code=${code} signal=${signal}); shutting down.`,
    );
    shutdown(code ?? 1);
  });
  return child;
}

/* ─── main ────────────────────────────────────────────────────────── */

async function main() {
  const serverDataDir = path.join(repoRoot, 'apps/server/data');

  // 1. Prime Electron's main/preload output. tsc is fast on incremental
  //    builds; the only reason to run it every time is that changes to
  //    these files require re-running the orchestrator anyway, so a
  //    fresh build is what the user expects when they kick this off.
  await runStep('Compiling @huabu/desktop (main + preload)', 'pnpm', [
    '--filter',
    '@huabu/desktop',
    'build',
  ]);

  // 1b. Resolve actually-free ports before spawning. If a stale Electron
  //     / tsx is still holding 3001 (or someone else owns 5173), slide
  //     to the next free port instead of crashing the orchestrator —
  //     and propagate that port to every consumer below so the Vite
  //     proxy and Electron's EXTERNAL_SERVER_URL stay in sync with
  //     wherever the server actually bound.
  const serverPort = await findAvailablePort(SERVER_PORT);
  if (serverPort !== SERVER_PORT) {
    console.warn(
      `[dev-desktop] Server port ${SERVER_PORT} is in use (often the installed ` +
        `Huabu desktop app running in the background); using ${serverPort} ` +
        `instead. Quit that app to free ${SERVER_PORT} if you prefer the default.`,
    );
  }
  const vitePort = await findAvailablePort(VITE_PORT);
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
    `[dev-desktop] Starting @huabu/server (tsx watch) on :${serverPort} …`,
  );
  spawnLongRunning('@huabu/server', 'server', {
    SERVER_PORT: String(serverPort),
    HUABU_BIND_HOST: HOST,
    HUABU_DATA_DIR: serverDataDir,
  });

  // 3. Start Vite in parallel. SPA fetches to `/api/*` will be proxied
  //    by Vite to SERVER_PORT, so both watchers must live on the same
  //    port pair the rest of the dev tooling expects. We pass the
  //    resolved ports through env so vite.config.ts's proxy target
  //    follows the server, and Vite itself binds the port we already
  //    probed as free (avoids Vite silently picking yet another port
  //    via its default strictPort:false fallback).
  console.log(`[dev-desktop] Starting @huabu/web (Vite) on :${vitePort} …`);
  spawnLongRunning('@huabu/web', 'web', {
    SERVER_PORT: String(serverPort),
    WEB_PORT: String(vitePort),
    VITE_PORT: String(vitePort),
    VITE_HANDBOOK_URL: HANDBOOK_URL,
  });

  // 4. Wait for both services to accept TCP connections before launching
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
    HUABU_DATA_DIR: serverDataDir,
    // Per-repo instance tag so several checkouts can run `dev:desktop` in
    // parallel without colliding. It flows into the Electron app name
    // (`Huabu Dev (<tag>)`) in apps/desktop/src/main.ts, which in turn
    // partitions each instance's `userData` tree AND its
    // single-instance lock. Defaults to this repo's folder name;
    // override with HUABU_INSTANCE to pin a stable tag.
    HUABU_INSTANCE: env.HUABU_INSTANCE || path.basename(repoRoot),
  };
  // VS Code's task terminal sometimes leaks this and it would make
  // `electron .` run as a plain Node process instead of an Electron app.
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  console.log('[dev-desktop] Launching Electron …');
  const electron = spawnSupervisedDevChild({
    command: 'pnpm',
    args: ['exec', 'electron', '.'],
    shell: true,
    cwd: path.join(repoRoot, 'apps/desktop'),
    env: electronEnv,
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
// one-shot `pnpm --filter @huabu/shared build` before the watchers.

main().catch((err) => {
  console.error('[dev-desktop]', err);
  shutdown(1);
});
