// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it, vi } from 'vitest';

import { PostgresSpaceRepository } from './space-repository.js';
import { unitContext } from './unit-test-support.js';
import { spaceRow } from '../sql/test-fixtures.js';
it('refuses absent, duplicated, or malformed world identities', async () => {
  const h = unitContext();
  const spaces = new PostgresSpaceRepository(h.context);
  await expect(spaces.worldId()).rejects.toThrow(/no World/);
  h.all.mockResolvedValue([spaceRow(), spaceRow()]);
  await expect(spaces.ensureWorld()).rejects.toThrow(/multiple World/);
  h.all.mockResolvedValue([spaceRow()]);
  await expect(spaces.worldId()).rejects.toThrow(/malformed/);
});
it('rejects non-finite creation clocks without writing', async () => {
  const h = unitContext(() => NaN);
  const spaces = new PostgresSpaceRepository(h.context);
  await expect(
    spaces.create({ canvasId: 'space', title: 'Title' }),
  ).rejects.toThrow(/clock/);
  await expect(spaces.ensureWorld()).rejects.toThrow(/clock/);
  expect(h.execute).not.toHaveBeenCalled();
});
it('releases deletion admission if the second read fails', async () => {
  const h = unitContext();
  const release = vi.fn();
  vi.spyOn(h.context, 'acquireDelete').mockResolvedValue(release);
  h.get
    .mockResolvedValueOnce(spaceRow())
    .mockRejectedValueOnce(new Error('read failed'));
  await expect(
    new PostgresSpaceRepository(h.context).beginDelete({ canvasId: 'space' }),
  ).rejects.toThrow('read failed');
  expect(release).toHaveBeenCalledTimes(1);
});
it('closes failed deletion sessions and releases admission exactly once', async () => {
  const h = unitContext();
  const release = vi.fn();
  vi.spyOn(h.context, 'acquireDelete').mockResolvedValue(release);
  h.get.mockResolvedValue(spaceRow());
  const result = await new PostgresSpaceRepository(h.context).beginDelete({
    canvasId: 'space',
  });
  if (!result.ok) throw new Error('Expected session');
  h.execute.mockRejectedValue(new Error('delete failed'));
  await expect(result.session.finish()).rejects.toThrow('delete failed');
  await result.session.abort();
  await expect(result.session.finish()).rejects.toThrow(/closed/);
  expect(release).toHaveBeenCalledTimes(1);
});
it('protects World without acquiring a deletion gate', async () => {
  const h = unitContext();
  h.get.mockResolvedValue({ ...spaceRow(), is_world: 1 });
  const acquire = vi.spyOn(h.context, 'acquireDelete');
  expect(
    await new PostgresSpaceRepository(h.context).beginDelete({
      canvasId: 'space',
    }),
  ).toEqual({ ok: false, reason: 'world-forbidden' });
  expect(acquire).not.toHaveBeenCalled();
});
