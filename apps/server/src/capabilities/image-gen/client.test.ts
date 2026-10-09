// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readCapabilityPackageFile } from '../../modules/capabilities/package-loader.js';

async function loadClient() {
  const source = readCapabilityPackageFile('image-gen', 'client.mjs');
  if (!source) throw new Error('Image Capability client is missing');
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  ) as Promise<{
    createClient(input: { config: Record<string, string> }): {
      generate(input: Record<string, string>): Promise<unknown>;
    };
  }>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Image Capability client', () => {
  it('uses classic Azure deployment routing', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const { createClient } = await loadClient();

    await createClient({
      config: {
        apiKey: 'test-secret',
        apiVersion: '2025-04-01-preview',
        baseUrl: 'https://example.test',
        model: 'image-deployment',
        modelFamily: 'gpt-image-1',
        quality: 'high',
      },
    }).generate({ prompt: '  a fox  ' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://example.test/openai/deployments/image-deployment/images/generations?api-version=2025-04-01-preview',
    );
    expect(init?.headers).toMatchObject({ 'api-key': 'test-secret' });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      prompt: 'a fox',
      quality: 'high',
    });
  });

  it('uses OpenAI-compatible v1 routing and bearer authentication', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const { createClient } = await loadClient();

    await createClient({
      config: {
        apiKey: 'test-secret',
        apiVersion: 'unused',
        baseUrl: 'https://example.test/openai/v1/',
        model: 'image-deployment',
        modelFamily: 'gpt-image-1',
        quality: 'medium',
      },
    }).generate({ prompt: 'a fox' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://example.test/openai/v1/images/generations',
    );
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer test-secret',
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'image-deployment',
      prompt: 'a fox',
    });
  });
});
