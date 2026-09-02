// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for the shared `generate-image` hosted-capability service.
 *
 * Coverage:
 *   ✓ bounded input validation (prompt / canvas context / size / quality)
 *   ✓ misconfigured deployment maps to `unavailable`
 *   ✓ missing reference artifact maps to `resource_not_found`
 *   ✓ artifact persistence is scoped to the supplied Canvas context only
 *   ✓ successful text-to-image result shaping
 *   ✓ provider (SDK) failure sanitization (`provider_failure`)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImageModelFamily } from '@huabu/shared';

const getAzureImageConfig = vi.fn();
const spaceRead = vi.fn<(key: string) => Promise<Buffer | null>>();
const spacePut = vi.fn<(key: string, bytes: Buffer) => Promise<void>>();
const spaceFn = vi.fn((canvasId: string) => ({
  canvasId,
  blobs: { read: spaceRead, put: spacePut },
}));
const imagesGenerate = vi.fn();
const imagesEdit = vi.fn();

vi.mock('../llm.js', () => ({
  getAzureImageConfig: () => getAzureImageConfig(),
}));

vi.mock('../../storage/index.js', () => ({
  space: (canvasId: string) => spaceFn(canvasId),
}));

vi.mock('openai', () => {
  class FakeClient {
    images = { generate: imagesGenerate, edit: imagesEdit };
  }
  return {
    OpenAI: FakeClient,
    AzureOpenAI: FakeClient,
    toFile: vi.fn(async (bytes: Buffer, name: string) => ({ bytes, name })),
  };
});

const { invokeImageGeneration } = await import('./image-generation.service.js');
const { HostedCapabilityError } = await import('./errors.js');

function azureConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    endpoint: 'https://example-resource.openai.azure.com',
    deployment: 'gpt-image-1',
    apiKey: 'azure-secret',
    apiVersion: '2025-04-01-preview',
    modelFamily: 'gpt-image-1' as ImageModelFamily,
    ...overrides,
  };
}

describe('invokeImageGeneration', () => {
  beforeEach(() => {
    getAzureImageConfig.mockReset().mockReturnValue(azureConfig());
    spaceRead.mockReset();
    spacePut.mockReset().mockResolvedValue(undefined);
    spaceFn.mockClear();
    imagesGenerate.mockReset();
    imagesEdit.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an empty prompt as invalid_input', async () => {
    await expect(
      invokeImageGeneration({ prompt: '  ' }, { canvasId: 'cv-1' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects a prompt over the Azure length cap as invalid_input', async () => {
    await expect(
      invokeImageGeneration({ prompt: 'x'.repeat(4001) }, { canvasId: 'cv-1' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('requires a Canvas context', async () => {
    await expect(
      invokeImageGeneration(
        { prompt: 'a cat' },
        { canvasId: '' as unknown as string },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('maps an unconfigured Azure deployment to unavailable without leaking the underlying message shape', async () => {
    getAzureImageConfig.mockImplementation(() => {
      throw new Error(
        'Azure image generation not configured. Open Settings → Image Provider → Azure OpenAI and fill in: Endpoint, API Key.',
      );
    });
    await expect(
      invokeImageGeneration({ prompt: 'a cat' }, { canvasId: 'cv-1' }),
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('Azure image generation not configured'),
    });
  });

  it('rejects an unsupported size for the configured family as invalid_input', async () => {
    await expect(
      invokeImageGeneration(
        { prompt: 'a cat', size: '999x999' },
        { canvasId: 'cv-1' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(imagesGenerate).not.toHaveBeenCalled();
  });

  it('rejects a missing reference artifact as resource_not_found, scoped to the supplied canvas', async () => {
    spaceRead.mockResolvedValue(null);

    await expect(
      invokeImageGeneration(
        { prompt: 'a cat', referenceArtifactSrcs: ['missing.png'] },
        { canvasId: 'cv-42' },
      ),
    ).rejects.toMatchObject({ code: 'resource_not_found' });

    expect(spaceFn).toHaveBeenCalledWith('cv-42');
    expect(spaceRead).toHaveBeenCalledWith('missing.png');
    expect(imagesGenerate).not.toHaveBeenCalled();
  });

  it('generates, persists into the supplied canvas only, and shapes the result', async () => {
    const b64 = Buffer.from('png-bytes').toString('base64');
    imagesGenerate.mockResolvedValue({
      data: [{ b64_json: b64, revised_prompt: 'a fluffy cat' }],
    });

    const result = await invokeImageGeneration(
      { prompt: 'a cat', size: '1024x1024' },
      { canvasId: 'cv-99' },
    );

    expect(result).toEqual({
      src: expect.stringMatching(/^gen-.+\.png$/),
      width: 1024,
      height: 1024,
      revisedPrompt: 'a fluffy cat',
    });
    expect(spaceFn).toHaveBeenCalledWith('cv-99');
    expect(spacePut).toHaveBeenCalledTimes(1);
    const [putKey, putBytes] = spacePut.mock.calls[0]!;
    expect(putKey).toEqual(result.src);
    expect(Buffer.compare(putBytes, Buffer.from('png-bytes'))).toBe(0);
    // Credentials never reach the result payload.
    expect(JSON.stringify(result)).not.toContain('azure-secret');
  });

  it('uses images.edit when reference artifacts are supplied', async () => {
    spaceRead.mockResolvedValue(Buffer.from('ref-bytes'));
    imagesEdit.mockResolvedValue({
      data: [{ b64_json: Buffer.from('out').toString('base64') }],
    });

    await invokeImageGeneration(
      { prompt: 'edit it', referenceArtifactSrcs: ['ref.png'] },
      { canvasId: 'cv-1' },
    );

    expect(imagesEdit).toHaveBeenCalledTimes(1);
    expect(imagesGenerate).not.toHaveBeenCalled();
  });

  it('sanitizes an SDK/provider failure into provider_failure', async () => {
    imagesGenerate.mockRejectedValue(
      Object.assign(new Error('Deployment not found'), { status: 404 }),
    );

    await expect(
      invokeImageGeneration({ prompt: 'a cat' }, { canvasId: 'cv-1' }),
    ).rejects.toBeInstanceOf(HostedCapabilityError);
    await expect(
      invokeImageGeneration({ prompt: 'a cat' }, { canvasId: 'cv-1' }),
    ).rejects.toMatchObject({ code: 'provider_failure' });
  });

  it('rejects a missing b64_json in the provider response as provider_failure', async () => {
    imagesGenerate.mockResolvedValue({ data: [{}] });

    await expect(
      invokeImageGeneration({ prompt: 'a cat' }, { canvasId: 'cv-1' }),
    ).rejects.toMatchObject({ code: 'provider_failure' });
  });
});
