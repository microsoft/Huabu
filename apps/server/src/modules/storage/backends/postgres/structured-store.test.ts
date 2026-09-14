// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it, vi } from 'vitest';

import { PostgresStructuredStore } from './structured-store.js';
import { unitContext } from './unit-test-support.js';
it('closes only contexts it owns', async () => {
  const shared = unitContext();
  const sharedClose = vi.spyOn(shared.context, 'close');
  await new PostgresStructuredStore(shared.context).close();
  expect(sharedClose).not.toHaveBeenCalled();
  const owned = new PostgresStructuredStore({});
  const ownedClose = vi.spyOn(owned.context, 'close');
  await owned.close();
  expect(ownedClose).toHaveBeenCalledOnce();
});
it('returns null extensions for absent spaces and rejects invalid namespaces before SQL', async () => {
  const h = unitContext();
  const space = new PostgresStructuredStore(h.context).space('space');
  expect(await space.extension('agent.test')).toBeNull();
  expect(h.execute).not.toHaveBeenCalled();
  await expect(space.extension('../invalid')).rejects.toThrow();
});
it('returns an extension substrate only with a numeric id', async () => {
  const h = unitContext();
  const space = new PostgresStructuredStore(h.context).space('space');
  h.get
    .mockResolvedValueOnce({ present: 1 })
    .mockResolvedValueOnce({ extension_id: 42 });
  expect(await space.extension('agent.test')).toMatchObject({
    kind: 'postgres',
    extensionId: 42,
  });
  h.get
    .mockResolvedValueOnce({ present: 1 })
    .mockResolvedValueOnce({ extension_id: '42' });
  await expect(space.extension('agent.test')).rejects.toThrow(/extension id/);
});
it('binds immutable handles to their active workspace', async () => {
  const h = unitContext();
  const space = new PostgresStructuredStore(h.context).space('space');
  expect(Object.isFrozen(space)).toBe(true);
  h.context.useWorkspace('other');
  await expect(space.read()).rejects.toThrow(/inactive Workspace/);
  await expect(space.extension('agent.test')).rejects.toThrow(
    /inactive Workspace/,
  );
});
