// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it, vi } from 'vitest';

import {
  appendSubstrateLog,
  readSubstrateDocument,
  writeSubstrateDocument,
} from './substrate-store.js';

import type { SpaceSubstrate } from '../storage/index.js';
function harness() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  const database = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
  const substrate = {
    kind: 'postgres',
    database,
    extensionId: 7,
  } as unknown as SpaceSubstrate;
  return { client, database, substrate };
}
it('prepares tables once for concurrent callers and binds namespace/document parameters', async () => {
  const h = harness();
  await Promise.all([
    writeSubstrateDocument(h.substrate, 'state', { count: 1 }),
    appendSubstrateLog(h.substrate, 'thread', '.log', 'block'),
  ]);
  expect(h.database.connect).toHaveBeenCalledTimes(1);
  expect(h.client.query).toHaveBeenLastCalledWith('COMMIT');
  expect(h.client.release).toHaveBeenCalledWith(false);
  expect(h.database.query).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO extension_documents'),
    [7, 'state', '{"count":1}'],
  );
  expect(h.database.query).toHaveBeenCalledWith(
    expect.stringContaining('extension_documents.body || excluded.body'),
    [7, 'thread.log', 'block'],
  );
});
it('retries failed table initialization and releases broken connections', async () => {
  const h = harness();
  const failure = new Error('DDL failed');
  h.client.query.mockImplementation(async (sql: string) => {
    if (sql.includes('CREATE TABLE')) throw failure;
    if (sql === 'ROLLBACK') throw new Error('disconnected');
    return { rows: [] };
  });
  await expect(readSubstrateDocument(h.substrate, 'state')).rejects.toBe(
    failure,
  );
  expect(h.client.release).toHaveBeenLastCalledWith(true);
  h.client.query.mockResolvedValue({ rows: [] });
  expect(await readSubstrateDocument(h.substrate, 'state')).toBeNull();
  expect(h.database.connect).toHaveBeenCalledTimes(2);
});
it('treats missing or malformed documents as absent but propagates database failures', async () => {
  const h = harness();
  expect(await readSubstrateDocument(h.substrate, 'state')).toBeNull();
  h.database.query.mockResolvedValueOnce({ rows: [{ body: '{' }] });
  expect(await readSubstrateDocument(h.substrate, 'state')).toBeNull();
  h.database.query.mockResolvedValueOnce({ rows: [{ body: '{"count":2}' }] });
  expect(await readSubstrateDocument(h.substrate, 'state')).toEqual({
    count: 2,
  });
  h.database.query.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(readSubstrateDocument(h.substrate, 'state')).rejects.toThrow(
    'database unavailable',
  );
});
it('rejects unsafe ids and nonrepresentable writes without storing a row', async () => {
  const h = harness();
  await expect(
    readSubstrateDocument(h.substrate, '../state'),
  ).rejects.toThrow();
  expect(h.database.connect).not.toHaveBeenCalled();
  await expect(
    writeSubstrateDocument(h.substrate, 'state', undefined),
  ).rejects.toThrow(/not representable/);
  expect(h.database.query).not.toHaveBeenCalled();
});
