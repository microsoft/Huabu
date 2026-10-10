// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readServicePackageFile } from '../../modules/services/package-loader.js';

async function loadEntry() {
  const source = readServicePackageFile('image-gen', 'entry.mjs');
  if (!source) throw new Error('Image Service entry is missing');
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  ) as Promise<{
    generate(input: {
      config: Record<string, string>;
      input: Record<string, string>;
    }): Promise<unknown>;
    main(argv: string[]): Promise<void>;
  }>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.AGENTLET_SERVICE_SDK_URL;
});

describe('Image Service entry', () => {
  it('uses classic Azure deployment routing', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const { generate } = await loadEntry();

    await generate({
      config: {
        apiKey: 'test-secret',
        apiVersion: '2025-04-01-preview',
        baseUrl: 'https://example.test',
        model: 'image-deployment',
        modelFamily: 'gpt-image-1',
        quality: 'high',
      },
      input: { prompt: '  a fox  ' },
    });

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
    const { generate } = await loadEntry();

    await generate({
      config: {
        apiKey: 'test-secret',
        apiVersion: 'unused',
        baseUrl: 'https://example.test/openai/v1/',
        model: 'image-deployment',
        modelFamily: 'gpt-image-1',
        quality: 'medium',
      },
      input: { prompt: 'a fox' },
    });

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

  it('runs as an executable entry using leased configuration', async () => {
    const bytes = Buffer.from('generated-image');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: bytes.toString('base64') }],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const sdkSource = `
      export async function withServiceContext(id, run) {
        if (id !== 'image-gen') throw new Error('Unexpected Service');
        return run({
          manifest: {
            name: 'Image Generation (AOAI)',
            configuration: [{
              id: 'quality',
              type: 'enum',
              options: [
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'high', label: 'high' },
                { value: 'auto', label: 'auto' }
              ]
            }]
          },
          config: {
            apiKey: 'test-secret',
            apiVersion: '2025-04-01-preview',
            baseUrl: 'https://example.test',
            model: 'image-deployment',
            modelFamily: 'gpt-image-1',
            quality: 'medium'
          }
        });
      }
    `;
    process.env.AGENTLET_SERVICE_SDK_URL = `data:text/javascript;base64,${Buffer.from(sdkSource).toString('base64')}`;
    const output = `${process.env.TMPDIR ?? '/tmp'}/huabu-image-entry-${process.pid}.png`;
    const { main } = await loadEntry();

    await main(['-p', 'a fox', '-o', output]);

    await expect(
      import('node:fs/promises').then((fs) => fs.readFile(output)),
    ).resolves.toEqual(bytes);
    await import('node:fs/promises').then((fs) => fs.rm(output));
  });

  it('renders runtime quality choices and configured default in help', async () => {
    const sdkSource = `
      export async function withServiceContext(id, run) {
        return run({
          manifest: {
            name: 'Image Generation (AOAI)',
            configuration: [{
              id: 'quality',
              type: 'enum',
              options: [
                { value: 'draft', label: 'Draft' },
                { value: 'final', label: 'Final' }
              ]
            }]
          },
          config: { quality: 'draft' }
        });
      }
    `;
    process.env.AGENTLET_SERVICE_SDK_URL = `data:text/javascript;base64,${Buffer.from(sdkSource).toString('base64')}`;
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const { main } = await loadEntry();

    await main(['--help']);

    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('Choices: draft, final'),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('Default: draft (config.quality)'),
    );
  });
});
