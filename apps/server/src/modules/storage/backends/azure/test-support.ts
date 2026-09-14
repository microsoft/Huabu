// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import { BlobServiceClient } from '@azure/storage-blob';
import { inject } from 'vitest';

import { AzureBlobStore } from './blob-store.js';

import type {} from '../../../../test-support/storage-containers.js';

export async function openAzureTestStore() {
  const connection = inject('azureConnectionString');
  if (!connection)
    throw new Error(
      'Run pnpm test:storage-backends to provision PostgreSQL and Azurite',
    );
  const container = BlobServiceClient.fromConnectionString(
    connection,
  ).getContainerClient(`test-${randomUUID()}`);
  await container.create();
  const workspace = { id: 'test-workspace' };
  const store = new AzureBlobStore(container, () => workspace.id);
  return {
    store,
    container,
    workspace,
    canvasId: 'test-space',
    cleanup: async () => {
      await store.close();
      await container.delete();
    },
  };
}

/** Isolated container wired through the same environment the Server consumes. */
export async function prepareAzureTestEnvironment() {
  const h = await openAzureTestStore();
  const previousConnection =
    process.env['HUABU_AZURE_STORAGE_CONNECTION_STRING'];
  const previousContainer = process.env['HUABU_AZURE_BLOB_CONTAINER'];
  const previousPrefix = process.env['HUABU_AZURE_BLOB_PREFIX'];
  process.env['HUABU_AZURE_STORAGE_CONNECTION_STRING'] = inject(
    'azureConnectionString',
  );
  process.env['HUABU_AZURE_BLOB_CONTAINER'] = h.container.containerName;
  process.env['HUABU_AZURE_BLOB_PREFIX'] = 'test';
  return async () => {
    for (const [key, previous] of [
      ['HUABU_AZURE_STORAGE_CONNECTION_STRING', previousConnection],
      ['HUABU_AZURE_BLOB_CONTAINER', previousContainer],
      ['HUABU_AZURE_BLOB_PREFIX', previousPrefix],
    ] as const) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    await h.cleanup();
  };
}
