// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renameOverWithRetry, renameOverWithRetrySync } from './fs.js';

import type * as NodeFs from 'node:fs';
import type * as NodeFsPromises from 'node:fs/promises';

const testState = vi.hoisted(() => ({
  renameSync: vi.fn(),
  renameAsync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, renameSync: testState.renameSync };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return { ...actual, rename: testState.renameAsync };
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`rename failed with ${code}`), { code });
}

let waitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  testState.renameSync.mockReset();
  testState.renameAsync.mockReset();
  waitSpy = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
});

afterEach(() => {
  vi.useRealTimers();
  waitSpy.mockRestore();
});

describe('renameOverWithRetrySync', () => {
  it('retries transient failures with the bounded backoff, then succeeds', () => {
    testState.renameSync
      .mockImplementationOnce(() => {
        throw errno('EPERM');
      })
      .mockImplementationOnce(() => {
        throw errno('EBUSY');
      })
      .mockReturnValueOnce(undefined);

    expect(() => renameOverWithRetrySync('from', 'to')).not.toThrow();

    expect(testState.renameSync).toHaveBeenCalledTimes(3);
    expect(
      waitSpy.mock.calls.map((call: unknown[]) => call[3] as number),
    ).toEqual([10, 20]);
  });

  it('throws after exhausting every transient retry', () => {
    const error = errno('EACCES');
    testState.renameSync.mockImplementation(() => {
      throw error;
    });

    expect(() => renameOverWithRetrySync('from', 'to')).toThrow(error);

    expect(testState.renameSync).toHaveBeenCalledTimes(6);
    expect(
      waitSpy.mock.calls.map((call: unknown[]) => call[3] as number),
    ).toEqual([10, 20, 40, 80, 160]);
  });

  it('propagates a non-transient failure without retrying', () => {
    const error = errno('EIO');
    testState.renameSync.mockImplementation(() => {
      throw error;
    });

    expect(() => renameOverWithRetrySync('from', 'to')).toThrow(error);

    expect(testState.renameSync).toHaveBeenCalledTimes(1);
    expect(waitSpy).not.toHaveBeenCalled();
  });
});

describe('renameOverWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('retries transient failures with the bounded backoff, then succeeds', async () => {
    testState.renameAsync
      .mockRejectedValueOnce(errno('EPERM'))
      .mockRejectedValueOnce(errno('EBUSY'))
      .mockResolvedValueOnce(undefined);

    const renaming = renameOverWithRetry('from', 'to');
    await vi.runAllTimersAsync();

    await expect(renaming).resolves.toBeUndefined();
    expect(testState.renameAsync).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting every transient retry', async () => {
    const error = errno('EACCES');
    testState.renameAsync.mockRejectedValue(error);

    const rejection = expect(renameOverWithRetry('from', 'to')).rejects.toBe(
      error,
    );
    await vi.runAllTimersAsync();

    await rejection;
    expect(testState.renameAsync).toHaveBeenCalledTimes(6);
  });

  it('propagates a non-transient failure without retrying', async () => {
    const error = errno('EIO');
    testState.renameAsync.mockRejectedValue(error);

    await expect(renameOverWithRetry('from', 'to')).rejects.toBe(error);

    expect(testState.renameAsync).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
