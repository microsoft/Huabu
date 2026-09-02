// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for the shared `web-search` hosted-capability service.
 *
 * Coverage:
 *   ✓ bounded input validation (`invalid_input`)
 *   ✓ missing-credential error (`unavailable`)
 *   ✓ result shaping from a Tavily response
 *   ✓ non-2xx provider failure mapping (`provider_failure`)
 *   ✓ timeout vs. caller-cancellation classification
 *   ✓ credentials never leak into the shaped result
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getTavilyApiKey = vi.fn<() => string | undefined>();

vi.mock('../../integrations/integrations.js', () => ({
  getTavilyApiKey: () => getTavilyApiKey(),
}));

const { invokeWebSearch } = await import('./web-search.service.js');
const { HostedCapabilityError } = await import('./errors.js');

describe('invokeWebSearch', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    getTavilyApiKey.mockReset().mockReturnValue('tavily-key');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rejects an empty query as invalid_input', async () => {
    await expect(invokeWebSearch({ query: '  ' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('rejects an out-of-bounds max_results as invalid_input', async () => {
    await expect(
      invokeWebSearch({ query: 'foo', maxResults: 11 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      invokeWebSearch({ query: 'foo', maxResults: 0 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('reports unavailable when no Tavily key is configured', async () => {
    getTavilyApiKey.mockReturnValue(undefined);
    await expect(invokeWebSearch({ query: 'foo' })).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('Missing Tavily API key'),
    });
  });

  it('shapes a successful Tavily response and never leaks the api key', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.api_key).toBe('tavily-key');
      return new Response(
        JSON.stringify({
          query: 'q',
          answer: 'the answer',
          results: [
            { title: 't', url: 'https://x', content: 'c', score: 0.9 },
            { url: '' }, // filtered out — no url
          ],
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await invokeWebSearch({ query: 'foo' });

    expect(result).toEqual({
      query: 'q',
      answer: 'the answer',
      results: [
        { title: 't', url: 'https://x', content: 'c', favicon: '', score: 0.9 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('tavily-key');
  });

  it('maps a non-2xx Tavily response to provider_failure', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('', { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(invokeWebSearch({ query: 'foo' })).rejects.toMatchObject({
      code: 'provider_failure',
      message: expect.stringContaining('Tavily request failed'),
    });
  });

  it('classifies a caller-cancelled request as cancelled, not timeout', async () => {
    globalThis.fetch = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted.', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const pending = invokeWebSearch(
      { query: 'foo' },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(HostedCapabilityError);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
});
