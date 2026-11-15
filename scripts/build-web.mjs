#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32' && command === 'pnpm.cmd',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result.stdout?.trim();
}

function pnpm(args) {
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, ...args]);
  } else {
    run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/build-web.mjs [--branch <origin-branch>]');
    return;
  }
  if (
    args.length !== 0 &&
    (args.length !== 2 || args[0] !== '--branch' || !args[1])
  ) {
    throw new Error(
      'Usage: node scripts/build-web.mjs [--branch <origin-branch>]',
    );
  }
  const branch = args[1];
  if (branch !== undefined) {
    if (branch.length > 255 || branch.startsWith('-')) {
      throw new Error('Invalid branch name.');
    }
    run('git', ['check-ref-format', '--branch', branch], true);
    run('git', ['check-ref-format', `refs/heads/${branch}`], true);
    if (
      run('git', ['rev-parse', '--show-toplevel'], true) !==
      path.resolve(repoRoot).replaceAll('\\', '/')
    ) {
      throw new Error('The build script must belong to the repository root.');
    }
    if (run('git', ['status', '--porcelain'], true)) {
      throw new Error('Working tree has uncommitted changes.');
    }
    const branchRef = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/origin/${branch}`;
    run('git', ['fetch', '--no-tags', 'origin', `${branchRef}:${remoteRef}`]);
    const localRefs = run(
      'git',
      ['for-each-ref', '--format=%(refname)', branchRef],
      true,
    );
    if (localRefs.split('\n').includes(branchRef)) {
      run('git', ['checkout', branch]);
      run('git', ['merge', '--ff-only', remoteRef]);
      if (
        run('git', ['rev-parse', 'HEAD'], true) !==
        run('git', ['rev-parse', remoteRef], true)
      ) {
        throw new Error(
          'Local branch is ahead of origin; refusing to deploy local commits.',
        );
      }
    } else {
      run('git', ['checkout', '-b', branch, '--track', remoteRef]);
    }
    pnpm(['install', '--frozen-lockfile']);
  }

  pnpm(['run', 'build:agentlet']);
  pnpm(['run', 'build:agenetes']);
  pnpm(['run', 'build:client-runtime']);
  pnpm(['--filter', '@huabu/shared', 'build']);
  pnpm(['--filter', '@huabu/server', 'bundle']);
  pnpm(['--filter', '@huabu/web', 'build']);
}

try {
  main();
} catch (error) {
  console.error(`Unable to build Huabu web: ${error.message}`);
  process.exitCode = 1;
}
