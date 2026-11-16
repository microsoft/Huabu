// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(
  new URL('./canary-redeploy-runner.mjs', import.meta.url),
);

for (const scenario of [
  'success',
  'build-failure',
  'restart-failure',
  'readiness-failure',
]) {
  test(`systemd runner: ${scenario}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'huabu-redeploy-runner-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const root = join(directory, 'repo');
    const bin = join(directory, 'bin');
    const calls = join(directory, 'calls');
    const statusPath = join(directory, 'status.json');
    const logPath = join(directory, 'update.log');
    const build = join(root, 'scripts', 'build-web.mjs');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(
      build,
      `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.TEST_CALLS, JSON.stringify(['build', process.cwd(), ...process.argv.slice(2)]) + '\\n');
process.exit(${scenario === 'build-failure' ? 7 : 0});
`,
    );
    const systemctl = join(bin, 'systemctl');
    writeFileSync(
      systemctl,
      `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.TEST_CALLS, JSON.stringify(['systemctl', ...process.argv.slice(2)]) + '\\n');
process.exit(${scenario === 'restart-failure' ? 9 : 0});
`,
    );
    chmodSync(systemctl, 0o755);
    let probes = 0;
    const server = createServer((request, response) => {
      probes++;
      assert.equal(request.url, '/api/deployment/readiness');
      assert.equal(
        request.headers.authorization,
        `Basic ${Buffer.from('owner:probe-password').toString('base64')}`,
      );
      response.writeHead(scenario === 'readiness-failure' ? 503 : 200);
      response.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HUABU_SERVICE_MANAGER: 'systemd-user',
      HUABU_CANARY_READINESS_TIMEOUT_SECONDS: '1',
      HUABU_CANARY_BASIC_AUTH_USER: 'owner',
      HUABU_CANARY_BASIC_AUTH_PASS: 'probe-password',
      SERVER_PORT: String(address.port),
      TEST_CALLS: calls,
    };
    const child = spawn(
      process.execPath,
      [
        runner,
        build,
        statusPath,
        logPath,
        '100',
        'x/alpha',
        '--environment-stdin',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HUABU_SERVICE_MANAGER: '' },
      },
    );
    let stdout = '';
    let stderr = '';
    let accepted = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (
        !accepted &&
        stdout.includes(`Huabu redeploy runner ready ${child.pid}\n`)
      ) {
        accepted = true;
        child.stdin.end('Huabu redeploy runner accepted\n');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.write(`${JSON.stringify(environment)}\n`);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, scenario === 'success' ? 0 : 1, stderr);
    assert.equal(stdout, `Huabu redeploy runner ready ${child.pid}\n`);
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(status.state, scenario === 'success' ? 'succeeded' : 'failed');
    assert.equal(status.branch, 'x/alpha');
    const recorded = existsSync(calls)
      ? readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
    assert.deepEqual(recorded, [
      ['build', root, '--branch', 'x/alpha'],
      ...(scenario === 'build-failure'
        ? []
        : [['systemctl', '--user', 'restart', 'huabu.service']]),
    ]);
    assert.equal(
      probes > 0,
      ['success', 'readiness-failure'].includes(scenario),
    );
    if (scenario === 'build-failure') assert.equal(status.exitCode, 7);
    if (scenario === 'restart-failure') assert.equal(status.exitCode, 9);
    if (scenario === 'readiness-failure') {
      assert.equal(status.message, 'Server readiness timed out after restart');
      assert.match(readFileSync(logPath, 'utf8'), /HTTP 503/);
    }
    assert.doesNotMatch(readFileSync(statusPath, 'utf8'), /probe-password/);
    assert.doesNotMatch(readFileSync(logPath, 'utf8'), /probe-password/);
  });
}

for (const confirmation of ['', 'rejected\n']) {
  test(`runner refuses ${confirmation ? 'invalid' : 'missing'} admission without changing status`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'huabu-redeploy-admission-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const statusPath = join(directory, 'status.json');
    const logPath = join(directory, 'update.log');
    const executed = join(directory, 'unexpected-execution');
    const hook = join(directory, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${executed}'\n`);
    chmodSync(hook, 0o755);
    const previousStatus = JSON.stringify({
      state: 'succeeded',
      branch: 'newer/branch',
      startedAt: 200,
      completedAt: 300,
      exitCode: 0,
    });
    writeFileSync(statusPath, previousStatus);
    const result = spawnSync(
      process.execPath,
      [
        runner,
        hook,
        statusPath,
        logPath,
        '100',
        'alpha',
        '--environment-stdin',
      ],
      {
        encoding: 'utf8',
        input: `${JSON.stringify({ ...process.env, HUABU_SERVICE_MANAGER: '' })}\n${confirmation}`,
        timeout: 5000,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^Huabu redeploy runner ready [1-9][0-9]*\n$/u);
    assert.match(
      result.stderr,
      /Redeploy admission (closed|was not confirmed)/u,
    );
    assert.equal(readFileSync(statusPath, 'utf8'), previousStatus);
    assert.equal(existsSync(executed), false);
    assert.equal(existsSync(logPath), false);
  });
}
