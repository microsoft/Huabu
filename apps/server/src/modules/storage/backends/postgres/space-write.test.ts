// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { createPostgresSpaceWrite } from './space-write.js';
import { unitContext } from './unit-test-support.js';
import { spaceRecord, spaceRow } from '../sql/test-fixtures.js';
const input = () => ({
  expectedVersion: 0,
  nextRecord: { ...spaceRecord(), version: 1 },
  nodeMutations: [],
});
it('reports missing spaces and version conflicts without mutation', async () => {
  const h = unitContext();
  const write = createPostgresSpaceWrite(h.context, 'workspace', 'space');
  expect(await write(input())).toEqual({ ok: false, reason: 'not-found' });
  h.get.mockResolvedValue({ ...spaceRow(), version: 2 });
  expect(await write(input())).toEqual({
    ok: false,
    reason: 'version-conflict',
    actualVersion: 2,
  });
  expect(h.execute).not.toHaveBeenCalled();
});
it.each([{ title: 'Different' }, { createdAt: 2 }])(
  'rejects immutable record changes %j',
  (change) => {
    const h = unitContext();
    h.get.mockResolvedValue(spaceRow());
    return expect(
      createPostgresSpaceWrite(
        h.context,
        'workspace',
        'space',
      )({ ...input(), nextRecord: { ...input().nextRecord, ...change } }),
    ).rejects.toThrow();
  },
);
it('rejects a lost update and never appends its delta', async () => {
  const h = unitContext();
  h.get.mockResolvedValue(spaceRow());
  h.execute.mockResolvedValue({ changes: 0 });
  await expect(
    createPostgresSpaceWrite(
      h.context,
      'workspace',
      'space',
    )({ ...input(), delta: { version: 1 } as never }),
  ).rejects.toThrow(/lost its version race/);
  expect(h.execute).toHaveBeenCalledTimes(1);
});
it('allows structural creation only from version zero', async () => {
  const h = unitContext();
  await expect(
    createPostgresSpaceWrite(
      h.context,
      'workspace',
      'space',
    )({
      ...input(),
      allowCreate: true,
      expectedVersion: 1,
      nextRecord: { ...spaceRecord(), version: 2 },
    }),
  ).rejects.toThrow(/version 0/);
  expect(h.execute).not.toHaveBeenCalled();
});
