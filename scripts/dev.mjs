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
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/** Minimal `.env` parser — just KEY=VALUE lines, ignores comments / blanks. */
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = {
  ...readEnvFile(path.join(repoRoot, '.env')),
  ...readEnvFile(path.join(repoRoot, 'apps/web/.env')),
  ...process.env,
};

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

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  // Give children a moment to exit cleanly before we do.
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** Spawn a `pnpm --filter <pkg> dev` child wired to our stdio. */
function spawnPnpmDev(filter, label) {
  const child = spawn('pnpm', ['--filter', filter, 'dev'], {
    cwd: repoRoot,
    stdio: 'inherit',
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

console.log('[dev] starting shared + server …');
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
