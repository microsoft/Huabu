#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const [scriptPath, statusPath, logPath, startedAtValue, branch] =
  process.argv.slice(2);
const startedAt = Number(startedAtValue);
const RESPONSE_GRACE_MS = 1500;
const branchIsValid =
  typeof branch === 'string' &&
  branch.length <= 255 &&
  !branch.startsWith('-') &&
  spawnSync('git', ['check-ref-format', '--branch', branch], {
    stdio: 'ignore',
  }).status === 0 &&
  spawnSync('git', ['check-ref-format', `refs/heads/${branch}`], {
    stdio: 'ignore',
  }).status === 0;

if (
  !scriptPath ||
  !statusPath ||
  !logPath ||
  !Number.isSafeInteger(startedAt) ||
  startedAt < 0 ||
  !branchIsValid
) {
  process.exitCode = 2;
} else {
  await mkdir(path.dirname(statusPath), { recursive: true });
  await mkdir(path.dirname(logPath), { recursive: true });

  async function writeStatus(status) {
    const temporaryPath = `${statusPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(status, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, statusPath);
  }

  await writeStatus({
    state: 'running',
    branch,
    startedAt,
    runnerPid: process.pid,
  });
  const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  log.write(`\n[${new Date().toISOString()}] Redeploying ${branch}\n`);

  await new Promise((resolveDelay) =>
    setTimeout(resolveDelay, RESPONSE_GRACE_MS),
  );
  const child = spawn(scriptPath, [branch, '--non-interactive'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  const result = await new Promise((resolveResult) => {
    child.once('error', (error) => {
      log.write(
        `[${new Date().toISOString()}] Unable to start redeploy script: ${error.message}\n`,
      );
      resolveResult({
        exitCode: -1,
        message: 'Unable to start redeploy script',
      });
    });
    child.once('exit', (code, signal) => {
      resolveResult({
        exitCode: code ?? -1,
        message: signal
          ? `Redeploy script exited after signal ${signal}`
          : undefined,
      });
    });
  });

  const succeeded = result.exitCode === 0;
  const status = {
    state: succeeded ? 'succeeded' : 'failed',
    branch,
    startedAt,
    completedAt: Date.now(),
    exitCode: result.exitCode,
    ...(!succeeded
      ? {
          message:
            result.message ??
            `Redeploy script exited with status ${result.exitCode}`,
        }
      : {}),
  };
  await writeStatus(status);
  log.write(
    `[${new Date().toISOString()}] Redeploy ${status.state} (exit ${result.exitCode})\n`,
  );
  log.end();
  process.exitCode = succeeded ? 0 : 1;
}
