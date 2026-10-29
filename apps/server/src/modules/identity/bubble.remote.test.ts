// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterEach, expect, inject, it } from 'vitest';

import { createIdentity, registerIdentity } from './index.js';

import type {} from '../../test-support/storage-containers.js';

const MASTER = { authorization: 'Bearer master-secret' };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** One Server process, configured from the environment as app.ts is. */
async function start(env: NodeJS.ProcessEnv) {
  const app = Fastify();
  const identity = createIdentity(env);
  registerIdentity(app, {
    service: identity.service,
    getConnectionToken: () => 'machine-secret',
  });
  if (!identity.bubble) throw new Error('Bubble was not selected');
  void app.register(identity.bubble, { prefix: '/bubble' });
  app.get('/api/data', async () => ({ private: true }));
  await app.ready();
  return app;
}

it('keeps principals, grants and local tokens across a restart, in a schema of its own', async () => {
  const url = inject('postgresUrl');
  const admin = new Pool({ connectionString: url, max: 1 });
  cleanup.push(async () => {
    try {
      await admin.query('DROP SCHEMA IF EXISTS bubble CASCADE');
    } finally {
      await admin.end();
    }
  });
  const env = {
    HUABU_IDENTITY_PROVIDER: 'bubble',
    HUABU_STRUCTURED_BACKEND: 'postgres',
    HUABU_POSTGRES_URL: url,
    HUABU_BUBBLE_AUTH:
      '[{"driver":"local-token"},{"driver":"master-key","masterKey":"master-secret","defaultPrincipalId":"admin"}]',
    HUABU_BUBBLE_OWNER: 'admin',
  };

  const first = await start(env);
  const bubbleApi = (path: string, payload: object) =>
    first.inject({
      method: 'POST',
      url: `/bubble/v1${path}`,
      headers: MASTER,
      payload,
    });
  expect(
    (await bubbleApi('/principals', { principalId: 'ci-bot', kind: 'bot' }))
      .statusCode,
  ).toBeLessThan(300);
  const minted = await bubbleApi('/principals/ci-bot/tokens', {});
  expect(minted.statusCode).toBeLessThan(300);
  const { token } = (minted.json() as { token: { token: string } }).token;
  const granted = await bubbleApi('/grants', {
    target: { type: 'system' },
    principalId: 'ci-bot',
    role: 'owner',
  });
  expect(granted.statusCode).toBeLessThan(300);
  await first.close();

  const second = await start(env);
  cleanup.push(() => second.close());
  const response = await second.inject({
    url: '/api/identity',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.json()).toMatchObject({
    principal: { principalId: 'ci-bot', kind: 'bot' },
    member: true,
    owner: true,
  });
  expect(
    (await second.inject({ url: '/api/data', headers: MASTER })).statusCode,
  ).toBe(200);
  const tables = await admin.query(
    'SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1',
    ['bubble'],
  );
  expect(tables.rows[0].n).toBeGreaterThan(0);
});
