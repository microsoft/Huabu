// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { createPostgresSpaceLogs } from './space-logs.js';
import { unitContext } from './unit-test-support.js';
import { event } from '../sql/test-fixtures.js';
it('validates old events before applying even a zero read limit', async () => {
  const h = unitContext();
  h.get.mockResolvedValue({ present: 1 });
  h.all.mockResolvedValue([
    { event_json: '{}' },
    { event_json: JSON.stringify(event()) },
  ]);
  await expect(
    createPostgresSpaceLogs(h.context, 'workspace', 'space').events.read(0),
  ).rejects.toThrow(/event 1/);
});
it('validates the whole event batch before entering a transaction', async () => {
  const h = unitContext();
  const logs = createPostgresSpaceLogs(h.context, 'workspace', 'space');
  await expect(
    logs.events.append([event(), { payload: {} } as never]),
  ).rejects.toThrow(/index 1/);
  expect(h.transaction).not.toHaveBeenCalled();
  await logs.events.append([]);
  expect(h.transaction).not.toHaveBeenCalled();
});
it('rejects missing-space mutations and malformed persisted changes', async () => {
  const h = unitContext();
  const logs = createPostgresSpaceLogs(h.context, 'workspace', 'space');
  await expect(logs.events.append([event()])).rejects.toThrow(/missing Space/);
  await expect(logs.changes.append('thread', [])).rejects.toThrow(
    /missing Space/,
  );
  h.get
    .mockResolvedValueOnce({ present: 1 })
    .mockResolvedValueOnce({ snapshot_json: '{}' });
  await expect(logs.changes.read('thread')).rejects.toThrow(/must be an array/);
  expect(h.execute).not.toHaveBeenCalled();
});
it('rejects retained event and change handles after workspace activation', async () => {
  const h = unitContext();
  const logs = createPostgresSpaceLogs(h.context, 'workspace', 'space');
  h.context.useWorkspace('other');
  await expect(logs.events.append([])).rejects.toThrow(/inactive Workspace/);
  await expect(logs.changes.read('thread')).rejects.toThrow(
    /inactive Workspace/,
  );
});
