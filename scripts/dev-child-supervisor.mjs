// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep the service process tree alive independently while retaining an IPC
// ownership link that survives abrupt task-runner termination.
const SUPERVISOR_PATH = fileURLToPath(import.meta.url);
// Agentlet's parallel POSIX cleanup takes at most 5s + 2s + 2s.
export const DEV_CHILD_SHUTDOWN_TIMEOUT_MS = 10_000;

function killTree(child, signal) {
  if (!child?.pid) return;
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
      /* already dead */
    }
  }
}

function validateSpec(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.command !== 'string' ||
    !Array.isArray(value.args) ||
    !value.args.every((arg) => typeof arg === 'string') ||
    typeof value.cwd !== 'string' ||
    typeof value.shell !== 'boolean'
  ) {
    throw new Error('Invalid supervised dev child specification');
  }
  return value;
}

function isGroupRunning(child) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export function waitForSupervisedDevChildren(children, code) {
  const active = children.filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  if (active.length === 0) {
    process.exit(code);
    return;
  }
  const deadline = setTimeout(() => {
    for (const child of active) {
      if (child.exitCode === null && child.signalCode === null) {
        killTree(child, 'SIGKILL');
      }
    }
    process.exit(code);
  }, DEV_CHILD_SHUTDOWN_TIMEOUT_MS + 1000);
  for (const child of active) {
    child.once('exit', () => {
      if (
        active.every(
          (child) => child.exitCode !== null || child.signalCode !== null,
        )
      ) {
        clearTimeout(deadline);
        process.exit(code);
      }
    });
  }
}

function supervise(serializedSpec) {
  const spec = validateSpec(JSON.parse(serializedSpec));
  let child;
  let shuttingDown = false;

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    killTree(child, 'SIGTERM');
    if (process.platform === 'win32') {
      process.exit(code);
      return;
    }
    const deadline = setTimeout(() => {
      clearInterval(poll);
      killTree(child, 'SIGKILL');
      process.exit(code);
    }, DEV_CHILD_SHUTDOWN_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (!isGroupRunning(child)) {
        clearTimeout(deadline);
        clearInterval(poll);
        process.exit(code);
      }
    }, 25);
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('disconnect', () => shutdown(0));

  if (!process.connected) {
    shutdown(1);
    return;
  }

  child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: spec.shell,
    detached: process.platform !== 'win32',
  });
  child.once('error', (error) => {
    console.error('[dev-child-supervisor]', error);
    shutdown(1);
  });
  child.once('exit', (code, signal) => {
    if (shuttingDown) return;
    shutdown(code ?? (signal ? 1 : 0));
  });
}

export function spawnSupervisedDevChild({
  command,
  args,
  cwd,
  env = process.env,
  shell = process.platform === 'win32',
}) {
  return spawn(
    process.execPath,
    [
      SUPERVISOR_PATH,
      '--supervise',
      JSON.stringify({ command, args, cwd, shell }),
    ],
    {
      cwd,
      env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      detached: process.platform !== 'win32',
    },
  );
}

if (process.argv[1] === SUPERVISOR_PATH && process.argv[2] === '--supervise') {
  supervise(process.argv[3]);
}
