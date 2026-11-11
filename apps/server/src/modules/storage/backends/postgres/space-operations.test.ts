// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createPostgresSpaceOperations } from './space-operations.js';
import { unitContext } from './unit-test-support.js';
import { newOperationSession } from '../../ports/operation-rules.js';

describe('PostgreSQL operation admission', () => {
  it('resolves an original terminal receipt before reading a changed head', async () => {
    const h = unitContext();
    const session = newOperationSession(randomUUID(), 0);
    const key = {
      principalId: 'owner',
      spaceEpoch: session.spaceEpoch,
      sessionId: session.sessionId,
      operationId: randomUUID(),
    };
    const receipt = {
      spaceEpoch: key.spaceEpoch,
      sessionId: key.sessionId,
      operationId: key.operationId,
      status: 'noop',
      atVersion: 0,
      commit: null,
      results: [{ commandIndex: 0, applied: false, reason: 'no-change' }],
    };
    h.get
      .mockResolvedValueOnce({
        principal_id: 'owner',
        session_json: JSON.stringify(session),
      })
      .mockResolvedValueOnce({
        digest: 'a'.repeat(64),
        receipt_json: JSON.stringify(receipt),
      });
    const store = createPostgresSpaceOperations(
      h.context,
      'workspace',
      'space',
    );
    expect(await store.lookup(key, 'a'.repeat(64))).toEqual({
      status: 'terminal',
      receipt,
    });
    expect(h.transaction).toHaveBeenCalledOnce();
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('refuses unsafe PostgreSQL settings before creating a lease', async () => {
    const h = unitContext();
    h.get.mockResolvedValue({
      fsync: 'off',
      full_page_writes: 'on',
      synchronous_commit: 'on',
    });
    await expect(
      createPostgresSpaceOperations(
        h.context,
        'workspace',
        'space',
      ).createSession('owner'),
    ).rejects.toMatchObject({ code: 'collaboration-disabled' });
    expect(h.execute.mock.calls).toEqual([
      ['SET LOCAL synchronous_commit = on'],
    ]);
  });

  it('preserves transaction uncertainty without retrying or returning a terminal failure', async () => {
    const h = unitContext();
    const failure = new Error('COMMIT reply lost');
    h.transaction.mockRejectedValue(failure);
    const session = newOperationSession(randomUUID(), 0);
    await expect(
      createPostgresSpaceOperations(h.context, 'workspace', 'space').lookup({
        principalId: 'owner',
        spaceEpoch: session.spaceEpoch,
        sessionId: session.sessionId,
        operationId: randomUUID(),
      }),
    ).rejects.toBe(failure);
    expect(h.transaction).toHaveBeenCalledOnce();
  });
});
