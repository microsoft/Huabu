// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readCapabilityPackageFile } from '../../modules/capabilities/package-loader.js';

async function loadClient() {
  const source = readCapabilityPackageFile('web-search', 'client.mjs');
  if (!source) throw new Error('Web Search Capability client is missing');
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  ) as Promise<{
    createClient(input: { config: Record<string, string> }): {
      search(input: string | Record<string, unknown>): Promise<unknown>;
    };
  }>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Web Search Capability client', () => {
  it('sends the configured Tavily key and normalized query', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const { createClient } = await loadClient();

    await createClient({
      config: { apiKey: 'test-secret' },
    }).search({ query: '  Huabu  ', max_results: 3 });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      api_key: 'test-secret',
      query: 'Huabu',
      max_results: 3,
    });
  });

  it('does not include provider response bodies in errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('sensitive provider response', { status: 401 }),
        ),
    );
    const { createClient } = await loadClient();

    await expect(
      createClient({ config: { apiKey: 'test-secret' } }).search('Huabu'),
    ).rejects.toThrow('Web search provider request failed (401)');
  });
});
