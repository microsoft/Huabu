// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  createNodeInvalidationTracker,
  retryTrackedInvalidation,
} from '../nodeInvalidationTracker';

describe('node invalidation tracker', () => {
  it('rejects an older GET after a newer inline commit', () => {
    const tracker = createNodeInvalidationTracker();
    const staleGet = tracker.begin('node-1', 'record-a', 2);

    tracker.cancelThrough('node-1', 3);

    expect(tracker.consume(staleGet)).toBe(false);
  });

  it('drops a delayed older GET response when inline data arrives first', async () => {
    const tracker = createNodeInvalidationTracker();
    const ticket = tracker.begin('node-1', 'record-a', 2);
    let resolveFetch: ((value: { content: string }) => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<{ content: string }>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const pending = retryTrackedInvalidation({ tracker, ticket, fetch });

    tracker.cancelThrough('node-1', 3);
    resolveFetch?.({ content: 'stale A' });

    await expect(pending).resolves.toBeNull();
  });

  it('does not let an older duplicate cancel a newer invalidation', () => {
    const tracker = createNodeInvalidationTracker();
    const latestGet = tracker.begin('node-1', 'record-c', 4);

    tracker.cancelThrough('node-1', 3);

    expect(tracker.consume(latestGet)).toBe(true);
  });

  it('retries a transient failed GET without losing the accepted invalidation', async () => {
    const tracker = createNodeInvalidationTracker();
    const ticket = tracker.begin('node-1', 'record-a', 2);
    const fetch = vi
      .fn<() => Promise<{ content: string } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ content: 'authoritative' });
    const wait = vi.fn(async () => undefined);

    await expect(
      retryTrackedInvalidation({ tracker, ticket, fetch, wait }),
    ).resolves.toEqual({ content: 'authoritative' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
    expect(tracker.consume(ticket)).toBe(true);
  });

  it('stops retrying when a later inline commit cancels the GET', async () => {
    const tracker = createNodeInvalidationTracker();
    const ticket = tracker.begin('node-1', 'record-a', 2);
    const fetch = vi.fn(async () => null);

    const result = await retryTrackedInvalidation({
      tracker,
      ticket,
      fetch,
      wait: async () => {
        tracker.cancelThrough('node-1', 3);
      },
    });

    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
