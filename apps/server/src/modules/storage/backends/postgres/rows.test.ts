// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import {
  insertSpaceRow,
  occupiedCollisionKeys,
  readSpaceRow,
  spaceRowExists,
  updateSpaceRow,
} from './rows.js';
import { unitContext } from './unit-test-support.js';
import { spaceRecord, spaceRow } from '../sql/test-fixtures.js';
it('binds workspace and space ids for reads without interpolating identifiers', async () => {
  const h = unitContext();
  h.get.mockResolvedValueOnce(spaceRow());
  expect(
    (await readSpaceRow(h.database, 'workspace', 'space'))?.record,
  ).toEqual(spaceRecord());
  expect(h.get).toHaveBeenCalledWith(
    expect.stringContaining('workspace_id = ? AND canvas_id = ?'),
    'workspace',
    'space',
  );
  expect(await readSpaceRow(h.database, 'other', 'space')).toBeNull();
  expect(await spaceRowExists(h.database, 'other', 'space')).toBe(false);
});
it('filters corrupt collision keys and reports the affected row count for CAS', async () => {
  const h = unitContext();
  h.all.mockResolvedValue([
    { collision_key: 'title' },
    { collision_key: null },
  ]);
  expect(await occupiedCollisionKeys(h.database, 'workspace')).toEqual([
    'title',
  ]);
  h.execute.mockResolvedValue({ changes: 0 });
  expect(
    await updateSpaceRow(
      h.database,
      'workspace',
      { ...spaceRecord(), version: 1 },
      0,
    ),
  ).toBe(0);
  expect(h.execute).toHaveBeenLastCalledWith(
    expect.stringContaining('AND version = ?'),
    1,
    JSON.stringify(spaceRecord().state),
    1,
    'workspace',
    'space',
    0,
  );
});
it('reserves the world collision key and validates records before SQL', async () => {
  const h = unitContext();
  await insertSpaceRow(h.database, 'workspace', spaceRecord(), 'ignored', true);
  expect(h.execute.mock.calls[0].slice(1)).toEqual([
    'space',
    'workspace',
    'Title',
    '.world',
    0,
    JSON.stringify(spaceRecord().state),
    1,
    1,
    1,
  ]);
  h.execute.mockClear();
  await expect(
    insertSpaceRow(
      h.database,
      'workspace',
      { ...spaceRecord(), version: NaN },
      'title',
    ),
  ).rejects.toThrow();
  expect(h.execute).not.toHaveBeenCalled();
});
