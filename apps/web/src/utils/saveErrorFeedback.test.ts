// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it, vi } from 'vitest';

import {
  holdSaveErrorRecovery,
  saveErrorsHandledByCaller,
  showSaveErrorRecovery,
  withSaveErrorsHandledByCaller,
} from './saveErrorFeedback';

it('retains recovery across nested save barriers until the error surface closes', async () => {
  const show = vi.fn();
  const release = holdSaveErrorRecovery();
  const releaseNested = holdSaveErrorRecovery();
  try {
    await expect(
      withSaveErrorsHandledByCaller(async () => {
        expect(saveErrorsHandledByCaller()).toBe(true);
        await withSaveErrorsHandledByCaller(async () => {
          showSaveErrorRecovery(show);
        });
        expect(show).not.toHaveBeenCalled();
        throw new Error('save failed');
      }),
    ).rejects.toThrow('save failed');
    expect(saveErrorsHandledByCaller()).toBe(false);
    expect(show).not.toHaveBeenCalled();
  } finally {
    releaseNested();
    expect(show).not.toHaveBeenCalled();
    release();
  }
  expect(show).toHaveBeenCalledOnce();
});

it('cancels stale recovery and waits for a still-running save after the surface closes', async () => {
  const show = vi.fn();
  const stale = vi.fn();
  const release = holdSaveErrorRecovery();
  await withSaveErrorsHandledByCaller(async () => {
    const cancel = showSaveErrorRecovery(stale);
    showSaveErrorRecovery(show);
    cancel?.();
    release();
    expect(show).not.toHaveBeenCalled();
  });
  expect(stale).not.toHaveBeenCalled();
  expect(show).toHaveBeenCalledOnce();
});

it('shows normal recovery immediately without claiming ordinary save errors', () => {
  const show = vi.fn();
  showSaveErrorRecovery(show);
  expect(show).toHaveBeenCalledOnce();
  expect(saveErrorsHandledByCaller()).toBe(false);
});
