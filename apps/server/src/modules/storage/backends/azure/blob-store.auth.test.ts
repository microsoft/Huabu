// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Readable } from 'node:stream';

import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobServiceClient,
  ContainerClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AzureBlobStore } from './blob-store.js';
import * as workspace from '../../../workspace.js';

import type { IHttpClient, WebResource } from '@azure/storage-blob';

const ACCOUNT_URL = 'https://example.blob.core.windows.net';
const CONNECTION =
  'DefaultEndpointsProtocol=https;AccountName=example;AccountKey=dGVzdC1vbmx5;EndpointSuffix=core.windows.net';

beforeEach(() => {
  vi.spyOn(workspace, 'getWorkspaceKey').mockReturnValue('workspace');
  vi.stubEnv('HUABU_AZURE_STORAGE_ACCOUNT_URL', '');
  vi.stubEnv('HUABU_AZURE_STORAGE_CONNECTION_STRING', '');
  vi.stubEnv('HUABU_AZURE_BLOB_CONTAINER', 'materials');
  vi.stubEnv('HUABU_AZURE_BLOB_PREFIX', 'test');
  // Never consult developer credentials or identity endpoints during tests.
  vi.stubEnv('AZURE_TOKEN_CREDENTIALS', 'ManagedIdentityCredential');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('selects Azure identity credentials for an account URL', () => {
  vi.stubEnv('HUABU_AZURE_STORAGE_ACCOUNT_URL', ` ${ACCOUNT_URL}/ `);
  vi.stubEnv('HUABU_AZURE_BLOB_CONTAINER', ' materials ');
  const store = AzureBlobStore.fromEnvironment();
  expect(store.container.url).toBe(`${ACCOUNT_URL}/materials`);
  expect(store.container.credential).toBeInstanceOf(DefaultAzureCredential);
});

it('keeps connection-string authentication available without an account URL', () => {
  vi.stubEnv('HUABU_AZURE_STORAGE_CONNECTION_STRING', ` ${CONNECTION} `);
  const store = AzureBlobStore.fromEnvironment();
  expect(store.container.url).toBe(`${ACCOUNT_URL}/materials`);
  expect(store.container.credential).toBeInstanceOf(StorageSharedKeyCredential);
});

it.each([
  { accountUrl: '', connection: '', container: 'materials' },
  { accountUrl: ' ', connection: ' ', container: 'materials' },
  { accountUrl: ACCOUNT_URL, connection: CONNECTION, container: 'materials' },
  { accountUrl: ACCOUNT_URL, connection: '', container: ' ' },
  { accountUrl: '', connection: CONNECTION, container: '' },
])('rejects missing or ambiguous Azure configuration: %j', (config) => {
  vi.stubEnv('HUABU_AZURE_STORAGE_ACCOUNT_URL', config.accountUrl);
  vi.stubEnv('HUABU_AZURE_STORAGE_CONNECTION_STRING', config.connection);
  vi.stubEnv('HUABU_AZURE_BLOB_CONTAINER', config.container);
  expect(() => AzureBlobStore.fromEnvironment()).toThrow(
    /HUABU_AZURE_BLOB_CONTAINER and exactly one of/,
  );
});

it.each([
  'not-a-url',
  'http://example.blob.core.windows.net',
  'https://user:private@example.blob.core.windows.net',
  `${ACCOUNT_URL}/materials`,
  `${ACCOUNT_URL}?sig=private`,
  `${ACCOUNT_URL}#private`,
])('rejects an unsafe identity endpoint: %s', (accountUrl) => {
  vi.stubEnv('HUABU_AZURE_STORAGE_ACCOUNT_URL', accountUrl);
  expect(() => AzureBlobStore.fromEnvironment()).toThrow(
    /HUABU_AZURE_STORAGE_ACCOUNT_URL must be/,
  );
  try {
    AzureBlobStore.fromEnvironment();
  } catch (error) {
    expect((error as Error).message).not.toContain('private');
  }
});

/** Replace only Azure's HTTP transport; its client, serialization and auth pipeline stay real. */
function interceptBlobRequests(sendRequest: IHttpClient['sendRequest']) {
  vi.spyOn(
    BlobServiceClient.prototype,
    'getContainerClient',
  ).mockImplementation(function (this: BlobServiceClient, container: string) {
    return new ContainerClient(
      `${this.url.replace(/\/$/, '')}/${container}`,
      this.credential,
      { httpClient: { sendRequest } },
    );
  });
}

it('uses Bearer tokens for server-side uploads and downloads, refreshing expired tokens without SAS', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubEnv('HUABU_AZURE_STORAGE_ACCOUNT_URL', ACCOUNT_URL);
  const token = vi
    .spyOn(DefaultAzureCredential.prototype, 'getToken')
    .mockImplementation(async () => ({
      token: 'first-token',
      expiresOnTimestamp: Date.now() + 3_600_000,
    }));
  const requests: Array<{ method: string; url: URL; authorization?: string }> =
    [];
  interceptBlobRequests(async (request: WebResource) => {
    requests.push({
      method: request.method,
      url: new URL(request.url),
      authorization: request.headers.get('authorization'),
    });
    const headers = request.headers.clone();
    headers.set('content-length', '5');
    headers.set('last-modified', new Date(1).toUTCString());
    headers.set('etag', '"test-etag"');
    return {
      request,
      status: request.method === 'PUT' ? 201 : 200,
      headers,
      readableStreamBody:
        request.method === 'GET' ? Readable.from(['hello']) : undefined,
    };
  });

  const store = AzureBlobStore.fromEnvironment();
  await store.init();
  const scope = store.space('space').artifacts;
  await scope.put('file', Buffer.from('hello'));
  expect(await scope.read('file')).toEqual(Buffer.from('hello'));
  expect(requests.map((request) => request.method)).toEqual([
    'GET',
    'PUT',
    'PUT',
    'GET',
  ]);
  expect(requests.every((r) => r.authorization === 'Bearer first-token')).toBe(
    true,
  );
  expect(requests[0].url.searchParams.get('restype')).toBe('container');
  expect(requests[1].url.searchParams.get('comp')).toBe('block');
  expect(requests[2].url.searchParams.get('comp')).toBe('blocklist');
  expect(requests[3].url.pathname).toMatch(
    /\/materials\/test\/.+\/space\/artifacts\/file$/,
  );
  expect(requests.every((r) => !r.url.searchParams.has('sig'))).toBe(true);
  expect(token.mock.calls[0][0]).toContain(
    'https://storage.azure.com/.default',
  );

  vi.setSystemTime(Date.now() + 7_200_000);
  token.mockImplementation(async () => ({
    token: 'refreshed-token',
    expiresOnTimestamp: Date.now() + 3_600_000,
  }));
  expect(await scope.read('file')).toEqual(Buffer.from('hello'));
  expect(requests.at(-1)?.authorization).toBe('Bearer refreshed-token');
  await store.close();
});

it('propagates identity failure without falling back to connection-string authentication', async () => {
  vi.stubEnv('HUABU_AZURE_STORAGE_ACCOUNT_URL', ACCOUNT_URL);
  const failure = new Error('managed identity unavailable');
  vi.spyOn(DefaultAzureCredential.prototype, 'getToken').mockRejectedValue(
    failure,
  );
  const connection = vi.spyOn(BlobServiceClient, 'fromConnectionString');
  const send = vi.fn<IHttpClient['sendRequest']>();
  interceptBlobRequests(send);
  const store = AzureBlobStore.fromEnvironment();
  await expect(store.init()).rejects.toBe(failure);
  expect(connection).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect((await store.health()).ok).toBe(false);
  await store.close();
});
