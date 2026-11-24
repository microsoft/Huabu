// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { createPostgresSpaceSave } from './space-save.js';
import { createPostgresSpaceWrite } from './space-write.js';
import { unitContext } from './unit-test-support.js';
import { SaveIdReusedError } from '../../ports/save.js';
import { spaceRecord, spaceRow } from '../sql/test-fixtures.js';

import type { SaveResult } from '../../ports/save.js';

const result = (digest = 'a'.repeat(64)): SaveResult => ({
  key: {
    principalId: 'principal',
    operationId: '0B6F3C52-7D1E-4C7A-9F3B-2A6F0E9D4C11',
  },
  digest,
  response: { ok: true },
});
const input = () => ({
  expectedVersion: 0,
  nextRecord: { ...spaceRecord(), version: 1 },
  nodeMutations: [],
});
const storedRow = {
  digest: 'a'.repeat(64),
  at_version: 3,
  response_json: '{"ok":true}',
};
const stored = { digest: 'a'.repeat(64), atVersion: 3, response: { ok: true } };
const isResultSelect = (sql: unknown) =>
  String(sql).includes('FROM space_save_results r');
const isHeadSelect = (sql: unknown) =>
  String(sql).includes('FROM space_save_heads');

it('adds one head lookup and no statement to a write without result or baseline', async () => {
  const h = unitContext();
  h.get.mockImplementation(async (sql) =>
    isHeadSelect(sql) ? undefined : spaceRow(),
  );
  const write = createPostgresSpaceWrite(h.context, 'workspace', 'space');
  expect(await write(input())).toEqual({ ok: true });
  expect(h.get.mock.calls.filter(([sql]) => isHeadSelect(sql))).toHaveLength(1);
  expect(h.get.mock.calls.some(([sql]) => isResultSelect(sql))).toBe(false);
  // The record update is the only statement that ran.
  expect(h.execute).toHaveBeenCalledTimes(1);
});

it('answers a stored result before reading the Space or writing anything', async () => {
  const h = unitContext();
  h.get.mockImplementation(async (sql) =>
    isResultSelect(sql) ? storedRow : spaceRow(),
  );
  const write = createPostgresSpaceWrite(h.context, 'workspace', 'space');
  expect(await write({ ...input(), result: result() })).toEqual({
    ok: false,
    reason: 'result-exists',
    stored,
  });
  expect(h.get).toHaveBeenCalledTimes(1);
  // The request id is matched the way UUIDs compare.
  expect(h.get.mock.calls[0]?.slice(1)).toEqual([
    'workspace',
    'space',
    'principal',
    '0b6f3c52-7d1e-4c7a-9f3b-2a6f0e9d4c11',
  ]);
  expect(h.execute).not.toHaveBeenCalled();

  await expect(
    write({ ...input(), result: result('b'.repeat(64)) }),
  ).rejects.toBeInstanceOf(SaveIdReusedError);
  expect(h.execute).not.toHaveBeenCalled();
});

it('stores the result row and advanced stamps after the record update', async () => {
  const h = unitContext(() => 5000);
  h.get.mockImplementation(async (sql) => {
    if (isResultSelect(sql)) return undefined;
    if (isHeadSelect(sql))
      return { lineage: 'lineage', floor: 0, stamps_json: '{}' };
    return spaceRow();
  });
  const write = createPostgresSpaceWrite(h.context, 'workspace', 'space');
  const next = {
    ...spaceRecord(),
    version: 1,
    state: { nodes: [{ id: 'n', type: 'note' }], edges: [] },
  };
  expect(
    await write({ ...input(), nextRecord: next, result: result() }),
  ).toEqual({ ok: true });
  const statements = h.execute.mock.calls.map(([sql]) =>
    String(sql).trim().split(/\s+/).slice(0, 3).join(' '),
  );
  expect(statements).toEqual([
    'UPDATE spaces SET',
    'UPDATE space_save_heads SET',
    'DELETE FROM space_save_results',
    'INSERT INTO space_save_results',
  ]);
  expect(h.execute.mock.calls[1]?.slice(1)).toEqual([
    '{"n":{"created":1,"membership":1}}',
    'space',
  ]);
  expect(h.execute.mock.calls[3]?.slice(1)).toEqual([
    'space',
    'principal',
    '0b6f3c52-7d1e-4c7a-9f3b-2a6f0e9d4c11',
    'a'.repeat(64),
    1,
    5000,
    '{"ok":true}',
  ]);
});

it('rolls back and answers from the stored row when the result insert loses a race', async () => {
  const h = unitContext();
  let resultSelects = 0;
  h.get.mockImplementation(async (sql) => {
    if (isResultSelect(sql)) {
      resultSelects += 1;
      return resultSelects === 1 ? undefined : storedRow;
    }
    return isHeadSelect(sql) ? undefined : spaceRow();
  });
  h.execute.mockImplementation(async (sql) => ({
    changes: String(sql).includes('INSERT INTO space_save_results') ? 0 : 1,
  }));
  let rejected = 0;
  h.transaction.mockImplementation(async (operation) => {
    try {
      return await operation(h.database);
    } catch (error) {
      rejected += 1;
      throw error;
    }
  });
  const write = createPostgresSpaceWrite(h.context, 'workspace', 'space');
  expect(await write({ ...input(), result: result() })).toEqual({
    ok: false,
    reason: 'result-exists',
    stored,
  });
  // The transaction was abandoned, so the state it wrote did not commit.
  expect(rejected).toBe(1);
});

it('creates the baseline once and reports an absent Space as null', async () => {
  const h = unitContext();
  const save = createPostgresSpaceSave(h.context, 'workspace', 'space');
  expect(await save.stamps()).toBeNull();
  expect(h.execute).not.toHaveBeenCalled();

  let head: Record<string, unknown> = {
    lineage: null,
    floor: null,
    stamps_json: null,
  };
  h.get.mockImplementation(async () => ({ version: 4, ...head }));
  h.execute.mockImplementation(async (_sql, ...parameters) => {
    head = {
      lineage: parameters[1],
      floor: parameters[2],
      stamps_json: parameters[3],
    };
    return { changes: 1 };
  });
  const created = await save.stamps();
  expect(created).toEqual({
    lineage: expect.stringMatching(/^[0-9a-f-]{36}$/),
    floor: 4,
    version: 4,
    nodes: {},
  });
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(await save.stamps()).toEqual(created);
  expect(h.execute).toHaveBeenCalledTimes(1);
});

it('records a result only at the expected version', async () => {
  const h = unitContext();
  const save = createPostgresSpaceSave(h.context, 'workspace', 'space');
  await expect(
    save.record({ expectedVersion: 0, result: result() }),
  ).rejects.toThrow(/missing Space/);
  h.get.mockImplementation(async (sql) =>
    isResultSelect(sql)
      ? undefined
      : { version: 2, lineage: null, floor: null, stamps_json: null },
  );
  expect(await save.record({ expectedVersion: 1, result: result() })).toEqual({
    ok: false,
    reason: 'version-conflict',
    actualVersion: 2,
  });
  expect(h.execute).not.toHaveBeenCalled();
  expect(await save.record({ expectedVersion: 2, result: result() })).toEqual({
    ok: true,
  });
  expect(h.execute.mock.calls.at(-1)?.slice(5, 7)).toEqual([2, 1]);
});
