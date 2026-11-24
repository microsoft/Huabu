// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { syncStateOf } from '../syncStatus';

import type { SendQueueStatus } from '../sendQueue';

const status = (patch: Partial<SendQueueStatus>): SendQueueStatus => ({
  canvasId: 'space',
  phase: 'idle',
  pending: 0,
  derivedPending: 0,
  failures: 0,
  ...patch,
});

describe('syncStateOf', () => {
  it('is synced with nothing waiting', () => {
    expect(syncStateOf(status({}))).toBe('synced');
  });

  it('is syncing while requests are answered normally', () => {
    expect(syncStateOf(status({ phase: 'sending', pending: 2 }))).toBe(
      'syncing',
    );
  });

  it('stays unsynced through the whole retry cycle, not only between attempts', () => {
    expect(
      syncStateOf(status({ phase: 'retrying', pending: 1, failures: 1 })),
    ).toBe('unsynced');
    expect(
      syncStateOf(status({ phase: 'sending', pending: 1, failures: 2 })),
    ).toBe('unsynced');
  });

  it('is synced while only derived reports wait, even failing ones', () => {
    expect(
      syncStateOf(
        status({
          phase: 'retrying',
          pending: 2,
          derivedPending: 2,
          failures: 3,
        }),
      ),
    ).toBe('synced');
    expect(
      syncStateOf(
        status({
          phase: 'retrying',
          pending: 2,
          derivedPending: 1,
          failures: 3,
        }),
      ),
    ).toBe('unsynced');
  });

  it('is an error once the queue has stalled', () => {
    expect(
      syncStateOf(status({ phase: 'stalled', pending: 1, failures: 8 })),
    ).toBe('error');
  });
});
