// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readServicePackageFile } from '../../modules/services/package-loader.js';

async function loadEntry() {
  const source = readServicePackageFile('web-search', 'entry.mjs');
  if (!source) throw new Error('Web Search Service entry is missing');
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  ) as Promise<{
    main(argv: string[]): Promise<void>;
    search(input: {
      config: Record<string, string>;
      input: string | Record<string, unknown>;
    }): Promise<unknown>;
  }>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENTLET_SERVICE_SDK_URL;
});

describe('Web Search Service entry', () => {
  it('sends the configured Tavily key and normalized query', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const { search } = await loadEntry();

    await search({
      config: { apiKey: 'test-secret' },
      input: { query: '  Huabu  ', max_results: 3 },
    });

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
    const { search } = await loadEntry();

    await expect(
      search({ config: { apiKey: 'test-secret' }, input: 'Huabu' }),
    ).rejects.toThrow('Web search provider request failed (401)');
  });

  it('runs as an executable entry using leased configuration', async () => {
    const result = { results: [{ title: 'Huabu' }] };
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(result))),
    );
    const sdkSource = `
      export async function withServiceConfig(id, run) {
        if (id !== 'web-search') throw new Error('Unexpected Service');
        return run({ config: { apiKey: 'test-secret' } });
      }
    `;
    process.env.AGENTLET_SERVICE_SDK_URL = `data:text/javascript;base64,${Buffer.from(sdkSource).toString('base64')}`;
    const output = `${process.env.TMPDIR ?? '/tmp'}/huabu-web-search-entry-${process.pid}.json`;
    const { main } = await loadEntry();

    await main(['-q', 'Huabu', '-o', output]);

    await expect(
      import('node:fs/promises').then((fs) => fs.readFile(output, 'utf8')),
    ).resolves.toBe(`${JSON.stringify(result, null, 2)}\n`);
    await import('node:fs/promises').then((fs) => fs.rm(output));
  });
});
