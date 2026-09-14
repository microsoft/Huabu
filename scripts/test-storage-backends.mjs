// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Disposable real services for the Phase 6 adapter and product contracts. */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const suffix = randomUUID().slice(0, 8);
const postgres = `huabu-test-postgres-${suffix}`;
const azure = `huabu-test-azurite-${suffix}`;
const containers = [];
const password = randomBytes(24).toString('hex');
const accountKey = randomBytes(32).toString('base64');
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
let child;
let stopping = false;
const cleanup = () => {
  for (const name of containers.splice(0).reverse()) {
    try {
      docker('rm', '-f', name);
    } catch {
      process.exitCode = 1;
    }
  }
};
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    stopping = true;
    child?.kill(signal);
    cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });

async function ready(probe, label) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if (await probe()) return;
    } catch {
      /* service still starting */
    }
    await setTimeout(500);
  }
  throw new Error(`${label} did not become ready`);
}

try {
  console.log('Starting disposable PostgreSQL 17 and Azurite containers...');
  docker(
    'run',
    '-d',
    '--rm',
    '--name',
    postgres,
    '-p',
    '127.0.0.1::5432',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_DB=huabu_test',
    'postgres:17',
  );
  containers.push(postgres);
  docker(
    'run',
    '-d',
    '--rm',
    '--name',
    azure,
    '-p',
    '127.0.0.1::10000',
    '-e',
    `AZURITE_ACCOUNTS=huabutest:${accountKey}`,
    'mcr.microsoft.com/azure-storage/azurite@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5',
    'azurite-blob',
    '--blobHost',
    '0.0.0.0',
    '--skipApiVersionCheck',
  );
  containers.push(azure);
  const pgPort = docker('port', postgres, '5432/tcp').split(':').at(-1);
  const blobPort = docker('port', azure, '10000/tcp').split(':').at(-1);
  await ready(() => {
    try {
      execFileSync(
        'docker',
        ['exec', postgres, 'pg_isready', '-U', 'postgres', '-d', 'huabu_test'],
        { stdio: 'ignore' },
      );
      return true;
    } catch {
      return false;
    }
  }, 'PostgreSQL');
  await ready(async () => {
    await fetch(`http://127.0.0.1:${blobPort}/huabutest`, {
      signal: AbortSignal.timeout(1000),
    });
    return true;
  }, 'Azurite');
  if (!stopping) {
    console.log(
      'Running adapter, conversation, and product contracts across all six profiles...',
    );
    child = spawn(
      'pnpm',
      [
        '--filter',
        '@huabu/server',
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.storage.config.ts',
      ],
      {
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: {
          ...process.env,
          HUABU_TEST_POSTGRES_URL: `postgresql://postgres:${password}@127.0.0.1:${pgPort}/huabu_test`,
          HUABU_TEST_AZURE_CONNECTION_STRING: `DefaultEndpointsProtocol=http;AccountName=huabutest;AccountKey=${accountKey};BlobEndpoint=http://127.0.0.1:${blobPort}/huabutest;`,
        },
      },
    );
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  }
} finally {
  cleanup();
}
