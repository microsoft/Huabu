// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { PostgresStoreContext } from './database.js';
import { PostgresStructuredStore } from './structured-store.js';
import { PostgresWorkspaceRepository } from './workspace-repository.js';

/** One disposable schema per case, created only on the explicit test database. */
export async function openPostgresTestStore(withWorld = true) {
  const connectionString = process.env['HUABU_TEST_POSTGRES_URL'];
  if (!connectionString)
    throw new Error(
      'Run pnpm test:storage-backends to provision PostgreSQL and Azurite',
    );
  const schema = `huabu_test_${randomUUID().split('-').join('')}`;
  const admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config = {
    connectionString,
    options: `-c search_path=${schema}`,
    max: 4,
  };
  const context = new PostgresStoreContext(config);
  try {
    await context.init();
    const repository = new PostgresWorkspaceRepository(context);
    const workspace = await repository.create('Test Workspace');
    context.useWorkspace(workspace.workspaceId);
    const store = new PostgresStructuredStore(context);
    const worldId = withWorld ? await store.spaces().ensureWorld() : null;
    return {
      store,
      context,
      config,
      workspaceId: workspace.workspaceId,
      worldId,
      cleanup: async () => {
        await context.close();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      },
    };
  } catch (error) {
    await context.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    throw error;
  }
}

export async function preparePostgresTestEnvironment() {
  const h = await openPostgresTestStore(false);
  const previous = process.env['HUABU_POSTGRES_URL'];
  const url = new URL(h.config.connectionString);
  url.searchParams.set('options', h.config.options);
  process.env['HUABU_POSTGRES_URL'] = url.toString();
  return async () => {
    if (previous === undefined) delete process.env['HUABU_POSTGRES_URL'];
    else process.env['HUABU_POSTGRES_URL'] = previous;
    await h.cleanup();
  };
}
