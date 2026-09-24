// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runText = vi.hoisted(() => vi.fn());
const complete = vi.hoisted(() => vi.fn());
vi.mock('../agent/functional-text.js', () => ({ runFunctionalText: runText }));
vi.mock('../agent/llm.js', () => ({ llmComplete: complete }));

import { ProviderManager } from './provider-manager.js';
import { MAX_INLINE_IMAGE_BYTES } from '../agent/conversation/prompt/image-inlining.js';

beforeEach(() => vi.clearAllMocks());

describe('external text enrichment', () => {
  const provider = new ProviderManager();
  const context = { canvasId: 'canvas-a' };

  it('uses the existing prompt and parses fenced metadata without built-in inference', async () => {
    runText.mockResolvedValue(
      '```json\n{"label":" Title ","summary":" Summary ","keywords":[" Keyword "]}\n```',
    );
    await expect(
      provider.generateContentMeta('source text', {}, context),
    ).resolves.toEqual({
      label: 'Title',
      summary: 'Summary',
      keywords: ['Keyword'],
    });
    expect(runText).toHaveBeenCalledWith(
      expect.stringContaining('source text'),
      context,
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns only requested fields', async () => {
    runText.mockResolvedValue(
      '{"label":"Title","summary":"Not requested","keywords":["ignored"]}',
    );
    await expect(
      provider.generateContentMeta(
        'source',
        { needSummary: false, needKeywords: false },
        context,
      ),
    ).resolves.toEqual({ label: 'Title' });
  });

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    '{"label":42}',
    '{"label":"Title","summary":"Summary","keywords":[42]}',
    '{"label":"Title"}',
  ])('rejects invalid or incomplete metadata: %s', async (response) => {
    runText.mockResolvedValue(response);
    await expect(
      provider.generateContentMeta('source', {}, context),
    ).rejects.toThrow();
  });

  it('skips empty source without launching an Agent', async () => {
    await expect(
      provider.generateContentMeta('  ', {}, context),
    ).resolves.toBeUndefined();
    expect(runText).not.toHaveBeenCalled();
  });

  it('propagates Agent failures so enrichment remains retryable', async () => {
    runText.mockRejectedValueOnce(new Error('default Profile unavailable'));
    await expect(
      provider.generateContentMeta('source', {}, context),
    ).rejects.toThrow('default Profile unavailable');
    expect(complete).not.toHaveBeenCalled();
  });

  it('generates a Frame title with the Space context', async () => {
    runText.mockResolvedValue('Topic');
    await expect(
      provider.generateFrameLabel(['Child one', 'Child two'], context),
    ).resolves.toBe('Topic');
    expect(runText).toHaveBeenCalledWith(
      expect.stringContaining('Child one'),
      context,
    );
  });

  it.each(['', 'x'.repeat(61), 'Two\nlines'])(
    'rejects an invalid Frame title',
    async (response) => {
      runText.mockResolvedValue(response);
      await expect(
        provider.generateFrameLabel(['Child'], context),
      ).rejects.toThrow('invalid Frame title');
    },
  );
});

describe('external image enrichment', () => {
  const provider = new ProviderManager();
  const png = 'data:image/png;base64,aGVsbG8=';

  it('sends image bytes through the existing functional runner without built-in inference', async () => {
    runText.mockResolvedValue('  A diagram  ');
    await expect(provider.generateImageLabel(png, 'canvas-a')).resolves.toBe(
      'A diagram',
    );
    expect(runText).toHaveBeenCalledWith(expect.any(String), {
      canvasId: 'canvas-a',
      images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(['', 'x'.repeat(61), 'Two\nlines'])(
    'rejects invalid image titles: %j',
    async (output) => {
      runText.mockResolvedValue(output);
      await expect(
        provider.generateImageLabel(png, 'canvas-a'),
      ).rejects.toThrow('invalid image title');
    },
  );

  it.each([
    'data:image/svg+xml;base64,aGVsbG8=',
    'data:image/png;base64,',
    `data:image/png;base64,${'A'.repeat(MAX_INLINE_IMAGE_BYTES * 2)}`,
  ])('rejects unavailable image input without dispatch', async (src) => {
    await expect(provider.generateImageLabel(src, 'canvas-a')).rejects.toThrow(
      'Image label input unavailable',
    );
    expect(runText).not.toHaveBeenCalled();
  });

  it('propagates external vision failures for retry instead of marking enrichment complete', async () => {
    runText.mockRejectedValueOnce(new Error('Agent does not support images'));
    await expect(provider.generateImageLabel(png, 'canvas-a')).rejects.toThrow(
      'does not support images',
    );
    expect(complete).not.toHaveBeenCalled();
  });
});
