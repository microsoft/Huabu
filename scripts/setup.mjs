// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const pnpmEntry = process.env.npm_execpath;

if (!pnpmEntry) {
  console.error('Run setup with pnpm run setup.');
  process.exit(1);
}

const build = spawnSync(
  process.execPath,
  [pnpmEntry, 'run', 'build:client-runtime'],
  { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
if (build.error || build.status !== 0) {
  console.error('Unable to prepare setup. Build output:');
  if (build.stdout) process.stderr.write(build.stdout);
  if (build.stderr) process.stderr.write(build.stderr);
  if (build.error) console.error(build.error.message);
  process.exit(build.status ?? 1);
}

const setup = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'src/setup.ts', ...process.argv.slice(2)],
  {
    cwd: fileURLToPath(new URL('../apps/server/', import.meta.url)),
    env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
    stdio: 'inherit',
  },
);
if (setup.error) console.error(`Unable to start setup: ${setup.error.message}`);
process.exitCode = setup.status ?? 1;
