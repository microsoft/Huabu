// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it, vi } from 'vitest';

import { createKeyedMutex } from './keyed-mutex.js';
it('serializes one key while allowing other keys to progress', async () => {
  const mutex = createKeyedMutex();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = mutex('a', () => gate);
  const second = vi.fn(() => 2);
  const next = mutex('a', second);
  expect(await mutex('b', () => 3)).toBe(3);
  expect(second).not.toHaveBeenCalled();
  release();
  await first;
  expect(await next).toBe(2);
});
it('recovers after synchronous throws and asynchronous rejection, including reused idle keys', async () => {
  const mutex = createKeyedMutex();
  const failed = expect(
    mutex('a', () => {
      throw new Error('sync');
    }),
  ).rejects.toThrow('sync');
  const next = mutex('a', () => 1);
  await failed;
  expect(await next).toBe(1);
  await expect(
    mutex('a', async () => {
      throw new Error('async');
    }),
  ).rejects.toThrow('async');
  expect(await mutex('a', () => 2)).toBe(2);
});
