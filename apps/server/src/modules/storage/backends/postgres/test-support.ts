// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { inject } from 'vitest';

import { PostgresStoreContext } from './database.js';
import { PostgresStructuredStore } from './structured-store.js';
import { PostgresWorkspaceRepository } from './workspace-repository.js';

import type {} from '../../../../test-support/storage-containers.js';

/** One disposable schema per case, always on the Testcontainers database. */
export async function openPostgresTestDatabase() {
  const connectionString = inject('postgresUrl');
  if (!connectionString)
    throw new Error(
      'Run pnpm test:storage-backends to provision PostgreSQL and Azurite',
    );
  const schema = `huabu_test_${randomUUID().split('-').join('')}`;
  const admin = new Pool({ connectionString, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  return {
    config: { connectionString, options: `-c search_path=${schema}`, max: 4 },
    cleanup: async () => {
      try {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}

export async function openPostgresTestStore(withWorld = true) {
  const database = await openPostgresTestDatabase();
  const context = new PostgresStoreContext(database.config);
  const cleanup = async () => {
    try {
      await context.close();
    } finally {
      await database.cleanup();
    }
  };
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
      config: database.config,
      workspaceId: workspace.workspaceId,
      worldId,
      cleanup,
    };
  } catch (error) {
    await cleanup();
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
