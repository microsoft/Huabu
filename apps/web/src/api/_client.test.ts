// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  apiErrorFromResponse,
  apiFetch,
  getRateLimitRetryAfterSeconds,
  RATE_LIMITED_EVENT,
  type RateLimitedEventDetail,
} from './_client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rate-limit API errors', () => {
  it('turns a 429 into ApiError and publishes its retry interval', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: 'Too many requests.',
            code: 'RATE_LIMITED',
            details: { retryAfterSeconds: 30 },
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': '42',
            },
          },
        ),
      ),
    );
    const details: RateLimitedEventDetail[] = [];
    const listener = (event: Event) => {
      details.push((event as CustomEvent<RateLimitedEventDetail>).detail);
    };
    window.addEventListener(RATE_LIMITED_EVENT, listener);

    let error: unknown;
    try {
      await apiFetch('/limited');
    } catch (caught) {
      error = caught;
    } finally {
      window.removeEventListener(RATE_LIMITED_EVENT, listener);
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 42 },
    });
    expect(getRateLimitRetryAfterSeconds(error)).toBe(42);
    expect(details).toEqual([{ retryAfterSeconds: 42 }]);
  });

  it('uses a safe retry fallback for a non-JSON SSE rejection', async () => {
    const error = await apiErrorFromResponse(
      new Response('Too Many Requests', { status: 429 }),
      'Stream failed',
    );

    expect(error.message).toBe('Stream failed');
    expect(error.code).toBe('RATE_LIMITED');
    expect(getRateLimitRetryAfterSeconds(error)).toBe(60);
  });
});
