// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Parity tests for the `generate_image` native tool adapter.
 *
 * The handler body was extracted into the shared hosted-capability
 * service (`../../hosted-capabilities/image-generation.service.ts`);
 * these tests pin that the adapter still maps pi-ai tool args plus the
 * executor-injected `canvasId` onto the service's `(input, context)`
 * contract 1:1, still returns the same JSON string wire shape, and
 * still lets a service error propagate unchanged so native behavior is
 * identical to before the extraction.
 */

import { describe, expect, it, vi } from 'vitest';

const invokeImageGeneration = vi.fn();

vi.mock('../../hosted-capabilities/image-generation.service.js', () => ({
  invokeImageGeneration: (...args: unknown[]) => invokeImageGeneration(...args),
}));

const { handleGenerateImage } = await import('./image-generation.js');

describe('handleGenerateImage', () => {
  it('maps tool args and canvasId onto the (input, context) service contract', async () => {
    invokeImageGeneration.mockResolvedValue({
      src: 'gen_x.png',
      width: 1024,
      height: 1024,
    });

    await handleGenerateImage({
      prompt: 'a cat',
      referenceArtifactSrcs: ['ref.png'],
      size: '1024x1024',
      quality: 'medium',
      canvasId: 'cv-1',
    });

    expect(invokeImageGeneration).toHaveBeenCalledWith(
      {
        prompt: 'a cat',
        referenceArtifactSrcs: ['ref.png'],
        size: '1024x1024',
        quality: 'medium',
      },
      { canvasId: 'cv-1' },
    );
  });

  it('never leaks canvasId into the capability input payload', async () => {
    invokeImageGeneration.mockResolvedValue({
      src: 'gen_x.png',
      width: 0,
      height: 0,
    });

    await handleGenerateImage({ prompt: 'a cat', canvasId: 'cv-1' });

    const [input] = invokeImageGeneration.mock.calls[0]!;
    expect(input).not.toHaveProperty('canvasId');
  });

  it('returns the service result as a JSON string, unwrapped', async () => {
    const serviceResult = {
      src: 'gen_x.png',
      width: 512,
      height: 512,
      revisedPrompt: 'a fluffy cat',
    };
    invokeImageGeneration.mockResolvedValue(serviceResult);

    const raw = await handleGenerateImage({
      prompt: 'a cat',
      canvasId: 'cv-1',
    });

    expect(raw).toBe(JSON.stringify(serviceResult));
  });

  it('propagates a service error unchanged (native error-message contract)', async () => {
    invokeImageGeneration.mockRejectedValue(
      new Error('Azure image request failed (HTTP 404): not found.'),
    );

    await expect(
      handleGenerateImage({ prompt: 'a cat', canvasId: 'cv-1' }),
    ).rejects.toThrow('Azure image request failed (HTTP 404): not found.');
  });
});
