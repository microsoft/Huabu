// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { spawnSupervisedDevChild } from './dev-child-supervisor.mjs';

const POLL_INTERVAL_MS = 25;
const TIMEOUT_MS = 15_000;

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

test(
  'waits across both supervisor layers for detached agent cleanup after the service exits',
  {
    skip: process.platform === 'win32',
    timeout: 20_000,
  },
  async () => {
    const pidFile = path.join(
      tmpdir(),
      `huabu-dev-agent-cleanup-${process.pid}.json`,
    );
    const workerScript = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const agent = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');"], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    agent.on('message', () => writeFileSync(process.argv[1], JSON.stringify({
      worker: process.pid, agent: agent.pid,
      service: Number(process.argv[2]), supervisor: Number(process.argv[3]),
    })));
    let stopping = false;
    process.on('SIGTERM', () => {
      if (stopping) return;
      stopping = true;
      setTimeout(() => {
        agent.once('exit', () => process.exit(0));
        agent.kill('SIGKILL');
      }, 9000);
    });
  `;
    const serviceScript = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', process.argv[2], process.argv[1], String(process.pid), String(process.ppid)], { stdio: 'ignore' });
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
    const launcherScript = `
    const { spawnSupervisedDevChild, waitForSupervisedDevChildren } = await import(process.argv[2]);
    const supervisor = spawnSupervisedDevChild({
      command: process.execPath, args: ['-e', process.argv[3], process.argv[1], process.argv[4]],
      cwd: process.cwd(), shell: false,
    });
    process.on('SIGTERM', () => {
      supervisor.kill('SIGTERM');
      waitForSupervisedDevChildren([supervisor], 0);
    });
  `;
    let launcher;
    let pids;
    try {
      await writeFile(pidFile, '');
      launcher = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          launcherScript,
          pidFile,
          new URL('./dev-child-supervisor.mjs', import.meta.url).href,
          serviceScript,
          workerScript,
        ],
        { stdio: 'ignore' },
      );
      await waitFor(async () => {
        const source = await readFile(pidFile, 'utf8');
        if (!source) return false;
        pids = JSON.parse(source);
        return Object.values(pids).every(isRunning);
      });
      const started = Date.now();
      launcher.kill('SIGTERM');
      assert.equal(await waitForExit(launcher), 0);
      assert.ok(Date.now() - started >= 9000);
      await waitFor(() => Object.values(pids).every((pid) => !isRunning(pid)));
    } finally {
      if (launcher?.exitCode === null && launcher?.signalCode === null)
        launcher.kill('SIGKILL');
      for (const pid of Object.values(pids ?? {})) {
        if (isRunning(pid)) process.kill(pid, 'SIGKILL');
      }
      await rm(pidFile, { force: true });
    }
  },
);
