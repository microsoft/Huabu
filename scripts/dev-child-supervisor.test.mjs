// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawnSupervisedDevChild } from './dev-child-supervisor.mjs';

const POLL_INTERVAL_MS = 25;
const TIMEOUT_MS = 5_000;

async function waitFor(readiness) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await readiness()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('Timed out waiting for supervised process state');
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once('exit', resolve);
  });
}

test('reaps the child process group when the owner IPC channel closes', async () => {
  const pidFile = path.join(
    tmpdir(),
    `huabu-dev-child-supervisor-${process.pid}.json`,
  );
  const childScript = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    writeFileSync(process.argv[1], JSON.stringify({
      child: process.pid,
      grandchild: grandchild.pid,
    }));
    setInterval(() => {}, 1000);
  `;
  let supervisor;
  let pids;

  try {
    await writeFile(pidFile, '');
    supervisor = spawnSupervisedDevChild({
      command: process.execPath,
      args: ['-e', childScript, pidFile],
      cwd: process.cwd(),
      env: process.env,
      shell: false,
    });
    await waitFor(async () => {
      try {
        const value = JSON.parse(await readFile(pidFile, 'utf8'));
        pids = value;
        return isRunning(value.child) && isRunning(value.grandchild);
      } catch {
        return false;
      }
    });

    supervisor.disconnect();

    await waitFor(() => !isRunning(pids.child) && !isRunning(pids.grandchild));
    assert.equal(await waitForExit(supervisor), 0);
  } finally {
    if (supervisor?.exitCode === null) supervisor.kill('SIGKILL');
    for (const pid of Object.values(pids ?? {})) {
      if (isRunning(pid)) process.kill(pid, 'SIGKILL');
    }
    await rm(pidFile, { force: true });
  }
});

test('reaps descendants left behind when the direct child exits', async () => {
  const pidFile = path.join(
    tmpdir(),
    `huabu-dev-child-descendant-${process.pid}.txt`,
  );
  const childScript = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    grandchild.unref();
    writeFileSync(process.argv[1], String(grandchild.pid));
  `;
  let supervisor;
  let grandchildPid;

  try {
    await writeFile(pidFile, '');
    supervisor = spawnSupervisedDevChild({
      command: process.execPath,
      args: ['-e', childScript, pidFile],
      cwd: process.cwd(),
      env: process.env,
      shell: false,
    });
    await waitFor(async () => {
      const value = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
      if (!Number.isInteger(value)) return false;
      grandchildPid = value;
      return true;
    });

    assert.equal(await waitForExit(supervisor), 0);
    await waitFor(() => !isRunning(grandchildPid));
  } finally {
    if (supervisor?.exitCode === null) supervisor.kill('SIGKILL');
    if (grandchildPid && isRunning(grandchildPid)) {
      process.kill(grandchildPid, 'SIGKILL');
    }
    await rm(pidFile, { force: true });
  }
});
