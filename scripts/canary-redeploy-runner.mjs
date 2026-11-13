#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const [
  scriptPath,
  statusPath,
  logPath,
  startedAtValue,
  branch,
  environmentMode,
] = process.argv.slice(2);
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
  !branchIsValid ||
  (environmentMode !== undefined && environmentMode !== '--environment-stdin')
) {
  process.exitCode = 2;
} else {
  let environment = process.env;
  if (environmentMode === '--environment-stdin') {
    let input = '';
    process.stdin.setEncoding('utf8');
    const chunks = process.stdin[Symbol.asyncIterator]();
    async function readLine() {
      while (!input.includes('\n')) {
        const chunk = await chunks.next();
        if (chunk.done) {
          throw new Error('Redeploy admission closed before confirmation');
        }
        input += chunk.value;
        if (Buffer.byteLength(input) > 1024 * 1024) {
          throw new Error('Redeploy environment exceeds the input limit');
        }
      }
      const newline = input.indexOf('\n');
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      return line;
    }
    const deadline = setTimeout(() => {
      process.stdin.destroy(
        new Error('Timed out waiting for redeploy admission'),
      );
    }, 10_000);
    try {
      const values = JSON.parse(await readLine());
      if (
        !values ||
        typeof values !== 'object' ||
        Array.isArray(values) ||
        !Object.values(values).every((value) => typeof value === 'string')
      ) {
        throw new Error('Invalid redeploy environment');
      }
      environment = { ...process.env, ...values };
      process.stdout.write(`Huabu redeploy runner ready ${process.pid}\n`);
      if ((await readLine()) !== 'Huabu redeploy runner accepted') {
        throw new Error('Redeploy admission was not confirmed');
      }
    } finally {
      clearTimeout(deadline);
      process.stdin.destroy();
    }
  }
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

  if (environmentMode !== '--environment-stdin') {
    await writeStatus({
      state: 'running',
      branch,
      startedAt,
      runnerPid: process.pid,
    });
  }
  const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  log.write(`\n[${new Date().toISOString()}] Redeploying ${branch}\n`);

  await new Promise((resolveDelay) =>
    setTimeout(resolveDelay, RESPONSE_GRACE_MS),
  );
  async function run(command, args, label) {
    log.write(`[${new Date().toISOString()}] ${label}\n`);
    const child = spawn(command, args, {
      cwd: path.dirname(path.dirname(scriptPath)),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });

    return new Promise((resolveResult) => {
      child.once('error', (error) => {
        log.write(
          `[${new Date().toISOString()}] Unable to start ${label}: ${error.message}\n`,
        );
        resolveResult({
          exitCode: -1,
          message: `Unable to start ${label}`,
        });
      });
      child.once('close', (code, signal) => {
        resolveResult({
          exitCode: code ?? -1,
          ...(code !== 0
            ? {
                message: signal
                  ? `${label} exited after signal ${signal}`
                  : `${label} exited with status ${code}`,
              }
            : {}),
        });
      });
    });
  }

  async function waitForReadiness() {
    const port = environment.SERVER_PORT ?? '3001';
    const seconds = environment.HUABU_CANARY_READINESS_TIMEOUT_SECONDS ?? '300';
    if (!/^[1-9][0-9]*$/u.test(port) || Number(port) > 65535) {
      return { exitCode: 2, message: 'Invalid Server port for readiness' };
    }
    if (
      !/^[1-9][0-9]*$/u.test(seconds) ||
      !Number.isSafeInteger(Number(seconds) * 1000)
    ) {
      return { exitCode: 2, message: 'Invalid readiness timeout' };
    }
    const headers = {};
    const user =
      environment.HUABU_CANARY_BASIC_AUTH_USER ??
      environment.HUABU_BASIC_AUTH_USER;
    const pass =
      environment.HUABU_CANARY_BASIC_AUTH_PASS ??
      environment.HUABU_BASIC_AUTH_PASS;
    if (user && pass) {
      headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }
    const deadline = Date.now() + Number(seconds) * 1000;
    let diagnostic = 'No response';
    log.write(`[${new Date().toISOString()}] Waiting for Server readiness\n`);
    while (Date.now() < deadline) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/deployment/readiness`,
          {
            headers,
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(2000, deadline - Date.now())),
            ),
          },
        );
        await response.body?.cancel();
        if (response.ok) return { exitCode: 0 };
        diagnostic = `HTTP ${response.status}`;
      } catch (error) {
        diagnostic = error.message;
      }
      await delay(Math.max(0, Math.min(1000, deadline - Date.now())));
    }
    log.write(
      `[${new Date().toISOString()}] Readiness timed out: ${diagnostic}\n`,
    );
    return { exitCode: 1, message: 'Server readiness timed out after restart' };
  }

  let result;
  if (environment.HUABU_SERVICE_MANAGER === 'systemd-user') {
    result = await run(
      process.execPath,
      [scriptPath, '--branch', branch],
      'Web build',
    );
    if (result.exitCode === 0) {
      result = await run(
        'systemctl',
        ['--user', 'restart', 'huabu.service'],
        'Service restart',
      );
    }
    if (result.exitCode === 0) result = await waitForReadiness();
  } else {
    result = await run(
      scriptPath,
      [branch, '--non-interactive'],
      'Redeploy script',
    );
  }

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
