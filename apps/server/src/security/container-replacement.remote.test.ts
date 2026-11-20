// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The App Service case: records in PostgreSQL, the master key from the
 * environment, and a data directory that does not survive the container.
 *
 * A replaced container starts with an empty data directory and an empty
 * private-config directory. Everything a person saved — credentials, model
 * settings, revocation state — must still be there, because none of it was
 * ever on that disk.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { DiskServerRecordStore } from '../modules/storage/backends/disk/server-records.js';
import { preparePostgresTestEnvironment } from '../modules/storage/backends/postgres/test-support.js';

const directories: string[] = [];
const releases: Array<() => Promise<void>> = [];

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const release of releases.splice(0).reverse()) await release();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

/** One Server process, booted on a fresh container filesystem. */
async function bootContainer(secretKey: string) {
  const dataDir = directory('huabu-container-data-');
  const configDir = directory('huabu-container-config-');
  vi.stubEnv('HUABU_DATA_DIR', dataDir);
  vi.stubEnv('HUABU_CONFIG_DIR', configDir);
  vi.stubEnv('HUABU_SECRET_KEY', secretKey);
  vi.resetModules();
  const secrets = await import('./secret-store.js');
  await secrets.initializeSecretStore();
  return {
    dataDir,
    configDir,
    secrets,
    defaults: await import('../modules/agent/agent-defaults.js'),
    credentials: await import('../modules/identity/agent-credentials.js'),
    close: async () =>
      (await import('../modules/storage/index.js')).closeStorage(),
  };
}

it('keeps credentials, settings, and revocations across a replaced container', async () => {
  releases.push(await preparePostgresTestEnvironment());
  vi.stubEnv('HUABU_STRUCTURED_BACKEND', 'postgres');
  const secretKey = randomBytes(32).toString('base64');

  const first = await bootContainer(secretKey);
  await first.secrets.setSecret('integration:tavily:api-key', 'tavily-key');
  await first.defaults.setAgentDefaults({
    profileId: 'utility-profile',
    functionalModel: 'small-model',
  });
  await first.credentials.resetAgentCredentials('alice');
  // Nothing durable landed on the container's disk.
  await expect(
    new DiskServerRecordStore(() => first.dataDir).keys(),
  ).resolves.toEqual([]);
  expect(readdirSync(first.configDir)).toEqual([]);
  await first.close();

  const second = await bootContainer(secretKey);
  try {
    expect(second.secrets.getSecret('integration:tavily:api-key')).toBe(
      'tavily-key',
    );
    expect(await second.defaults.getAgentDefaults()).toEqual({
      profileId: 'utility-profile',
      functionalModel: 'small-model',
    });
    await second.credentials.resetAgentCredentials('alice');
    const { getServerRecords } = await import('../modules/storage/index.js');
    expect(
      await getServerRecords().get({
        owner: null,
        name: 'agent-credential-versions',
      }),
    ).toEqual({ alice: 2 });
  } finally {
    await second.close();
  }
});

it('refuses to start without HUABU_SECRET_KEY instead of keeping a key on local disk', async () => {
  vi.stubEnv('HUABU_STRUCTURED_BACKEND', 'postgres');
  vi.stubEnv('HUABU_POSTGRES_URL', '');
  const configDir = directory('huabu-container-config-');
  vi.stubEnv('HUABU_CONFIG_DIR', configDir);
  vi.stubEnv('HUABU_DATA_DIR', directory('huabu-container-data-'));
  delete process.env.HUABU_SECRET_KEY;
  vi.resetModules();
  const secrets = await import('./secret-store.js');

  await expect(secrets.initializeSecretStore()).rejects.toThrow(
    'PostgreSQL credential storage requires HUABU_SECRET_KEY',
  );
  expect(readdirSync(configDir)).toEqual([]);
});
