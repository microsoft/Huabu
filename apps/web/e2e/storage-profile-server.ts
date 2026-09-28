// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Backend lifecycle for the storage-profile acceptance run.
 *
 * The other e2e configs hand the server to Playwright's `webServer`, which is
 * right when a suite only needs the backend to exist. This one needs to *stop
 * and start it again* mid-test: the claim under test is that an Agent's
 * conversation is durable in the selected backend, and the only honest way to
 * show that is to take the process away and bring it back. Playwright owns its
 * `webServer` children and offers no restart, so the backend is spawned here
 * instead and its coordinates are written to a state file.
 *
 * The state file is how the spec reaches a process the *runner* started:
 * globalSetup and a worker are different processes, so a module-level handle
 * would not survive the crossing. A pid and an argv is all a restart needs.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(e2eRoot, '../../..');

export interface BackendState {
  pid: number;
  port: string;
  env: Record<string, string>;
}

/** Where the runner leaves the backend's coordinates for the worker to find. */
export function backendStateFile(): string {
  const path = process.env.E2E_BACKEND_STATE;
  if (!path)
    throw new Error(
      'E2E_BACKEND_STATE is unset; the storage-profile config sets it',
    );
  return path;
}

function readState(): BackendState {
  return JSON.parse(readFileSync(backendStateFile(), 'utf8')) as BackendState;
}

/** Where the backend's own output goes, so a failed start is diagnosable. */
function backendLogFile(): string {
  return `${backendStateFile()}.log`;
}

function recentBackendOutput(): string {
  try {
    return readFileSync(backendLogFile(), 'utf8')
      .split('\n')
      .slice(-25)
      .join('\n');
  } catch {
    return '(no backend output captured)';
  }
}

async function waitForHealth(port: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/workspace`);
      if (response.ok) return;
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Backend on port ${port} never became healthy: ${String(lastError)}\n` +
      `--- backend output ---\n${recentBackendOutput()}`,
  );
}

/** Whether anything is still listening on `port`. */
function portInUse(port: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: Number(port) }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Wait until the old listener is really gone.
 *
 * The exiting Server closes a Postgres pool and an Azure client before it
 * releases the socket, so the wrapper process can be reaped while the port is
 * still bound. Starting the replacement then races a bind that fails, the new
 * process exits, and the restart looks like a product failure when it is only
 * a handover. This is the wait that makes the handover deterministic.
 */
async function waitForPortFree(
  port: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Port ${port} was still held after the backend was stopped`);
}

async function waitForExit(pid: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Backend pid ${pid} did not exit`);
}

/**
 * Put the LLM credentials this deployment already holds into the throwaway
 * data dir.
 *
 * The suite drives a *real* model turn, because a stubbed one would prove
 * nothing about whether a turn survives a restart — a recovered conversation
 * is only evidence if something actually generated it. The credentials stay
 * where they are; the run copies the two files it needs into its own data dir
 * and the teardown deletes that dir with them.
 *
 * Returns whether the copy happened, so a machine without credentials runs the
 * storage half of the suite and skips the model half instead of failing.
 *
 * Readiness is the whole decryptable set, not the two filenames.
 * `encrypted-secrets.json` cannot be read without the master key, and
 * `initializeSecretStore` treats that pairing as fatal rather than falling
 * back to the environment (`apps/server/src/security/secret-store.ts`). So
 * staging the file without `HUABU_SECRET_KEY` would fail the backend's start
 * inside globalSetup, before any `test.skip` could be reached — taking the
 * credential-free storage test down with it, on the common machine that has
 * the files checked out but no key exported.
 */
export function stageLlmCredentials(dataDir: string): boolean {
  const from = process.env.E2E_LLM_CREDENTIALS_FROM
    ? resolve(process.env.E2E_LLM_CREDENTIALS_FROM)
    : join(repoRoot, 'apps/server/data');
  const files = ['llm-config.json', 'encrypted-secrets.json'];
  if (!files.every((name) => existsSync(join(from, name)))) return false;
  if (!process.env.HUABU_SECRET_KEY?.trim()) return false;
  mkdirSync(dataDir, { recursive: true });
  for (const name of files) copyFileSync(join(from, name), join(dataDir, name));
  return true;
}

/** Spawn the backend and wait until it serves its Workspace. */
export async function startBackend(
  port: string,
  env: Record<string, string>,
): Promise<BackendState> {
  const output = openSync(backendLogFile(), 'a');
  const child = spawn('pnpm', ['--filter', '@huabu/server', 'start'], {
    cwd: repoRoot,
    env: { ...process.env, ...env, SERVER_PORT: port },
    stdio: ['ignore', output, output],
    detached: true,
  });
  child.unref();
  if (!child.pid) throw new Error('Backend did not start');
  const state: BackendState = { pid: child.pid, port, env };
  writeFileSync(backendStateFile(), JSON.stringify(state), 'utf8');
  await waitForHealth(port);
  return state;
}

/**
 * Take down the backend's whole process tree.
 *
 * The spawn was detached, so on POSIX the pnpm wrapper and the server it
 * exec'd share a process group, and signalling the group is what actually
 * frees the port. Windows has no group to signal: a negative pid throws
 * there, and swallowing that would leave the backend running until
 * `restartBackend` gave up waiting for a port that never came free. Mirrors
 * `killTree` in `scripts/dev-child-supervisor.mjs`, which already solves this
 * for the dev stack.
 */
function killBackendTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** Stop the backend, leaving whatever it persisted behind. */
export async function stopBackend(): Promise<void> {
  if (!existsSync(backendStateFile())) return;
  const state = readState();
  killBackendTree(state.pid, 'SIGTERM');
  try {
    await waitForExit(state.pid);
  } catch {
    killBackendTree(state.pid, 'SIGKILL');
  }
}

/**
 * Take the backend away and bring it back on the same durable state.
 *
 * Nothing about the deployment changes across the restart — same profile, same
 * database, same blob container — so anything the suite still observes
 * afterwards came out of the backend rather than out of a process's memory.
 */
export async function restartBackend(): Promise<void> {
  const state = readState();
  await stopBackend();
  await waitForPortFree(state.port);
  await startBackend(state.port, state.env);
}

export function clearBackendState(): void {
  rmSync(backendStateFile(), { force: true });
  rmSync(backendLogFile(), { force: true });
}
