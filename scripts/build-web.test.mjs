// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'huabu-build-web-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  const remote = join(directory, 'remote.git');
  const calls = join(directory, 'pnpm.jsonl');
  const pnpmEntry = join(directory, 'pnpm.cjs');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(
    new URL('./build-web.mjs', import.meta.url),
    join(root, 'scripts/build-web.mjs'),
  );
  writeFileSync(
    pnpmEntry,
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BUILD_TEST_LOG, JSON.stringify(args) + '\\n');
if (args.includes(process.env.BUILD_TEST_FAIL)) process.exit(7);
`,
  );
  function git(args, cwd = root) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(['init', '--bare', remote], directory);
  git(['init', '-b', 'alpha']);
  git(['config', 'user.email', 'build@example.test']);
  git(['config', 'user.name', 'Build Test']);
  git(['add', '.']);
  git(['commit', '-m', 'Initial build script']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', 'origin', 'alpha']);
  return {
    root,
    git,
    calls: () =>
      existsSync(calls)
        ? readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
        : [],
    build: (args = [], env = {}) =>
      spawnSync(
        process.execPath,
        [join(root, 'scripts/build-web.mjs'), ...args],
        {
          cwd: directory,
          encoding: 'utf8',
          env: {
            ...process.env,
            npm_execpath: pnpmEntry,
            BUILD_TEST_LOG: calls,
            ...env,
          },
        },
      ),
  };
}

test('builds the current dirty checkout without installing or changing branches', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'local.txt'), 'local changes');
  const result = f.build();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [
    ['run', 'build:agentlet'],
    ['run', 'build:agenetes'],
    ['run', 'build:client-runtime'],
    ['--filter', '@huabu/shared', 'build'],
    ['--filter', '@huabu/server', 'bundle'],
    ['--filter', '@huabu/web', 'build'],
  ]);
  assert.equal(f.git(['branch', '--show-current']), 'alpha');
});

test('fetches a nested branch, creates it, installs locked dependencies, and fast-forwards later builds', (t) => {
  const f = fixture(t);
  f.git(['push', 'origin', 'alpha:refs/heads/x/alpha']);
  let result = f.build(['--branch', 'x/alpha']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git(['branch', '--show-current']), 'x/alpha');
  assert.deepEqual(f.calls()[0], ['install', '--frozen-lockfile']);
  f.git(['checkout', 'alpha']);
  writeFileSync(join(f.root, 'new.txt'), 'remote update');
  f.git(['add', '.']);
  f.git(['commit', '-m', 'Remote update']);
  const sha = f.git(['rev-parse', 'HEAD']);
  f.git(['push', 'origin', 'alpha:refs/heads/x/alpha']);
  result = f.build(['--branch', 'x/alpha']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git(['rev-parse', 'HEAD']), sha);
});

test('rejects dirty, divergent, and locally ahead deployments before installing', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'local.txt'), 'local');
  let result = f.build(['--branch', 'alpha']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /uncommitted changes/);
  f.git(['add', '.']);
  f.git(['commit', '-m', 'Local-only revision']);
  result = f.build(['--branch', 'alpha']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ahead of origin/);
  f.git(['checkout', '-b', 'remote-update', 'origin/alpha']);
  writeFileSync(join(f.root, 'remote.txt'), 'remote');
  f.git(['add', '.']);
  f.git(['commit', '-m', 'Divergent remote revision']);
  f.git(['push', 'origin', 'remote-update:alpha']);
  result = f.build(['--branch', 'alpha']);
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.calls(), []);
});

test('rejects invalid arguments and unavailable branches without building', (t) => {
  const f = fixture(t);
  for (const args of [
    ['--branch'],
    ['--branch', '-bad'],
    ['--branch', 'HEAD'],
    ['--branch', 'bad..branch'],
    ['--branch', 'missing'],
    ['--unknown'],
  ]) {
    const result = f.build(args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
  }
  assert.deepEqual(f.calls(), []);
});

test('propagates a build failure and skips all later build steps', (t) => {
  const f = fixture(t);
  const result = f.build([], { BUILD_TEST_FAIL: 'build:agenetes' });
  assert.equal(result.status, 7);
  assert.deepEqual(f.calls(), [
    ['run', 'build:agentlet'],
    ['run', 'build:agenetes'],
  ]);
});
