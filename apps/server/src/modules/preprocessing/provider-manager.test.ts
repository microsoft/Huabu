// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Transient-vs-genuine provider error classification.
 *
 * Transient failures (gateway down, OAuth refresh failed, network blip, rate
 * limit) must be rethrown so the pipeline records a retryable diagnostic
 * instead of silently persisting an empty enrich result — which would look
 * identical to "this node has nothing worth enriching".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runText = vi.hoisted(() => vi.fn());
const complete = vi.hoisted(() => vi.fn());
vi.mock('../agent/functional-text.js', () => ({ runFunctionalText: runText }));
vi.mock('../agent/llm.js', () => ({ llmComplete: complete }));

import {
  isTransientProviderError,
  ProviderManager,
} from './provider-manager.js';

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

describe('isTransientProviderError', () => {
  it('classifies OAuth / auth failures as transient', () => {
    expect(
      isTransientProviderError(
        new Error(
          'Authentication failed for provider "github-copilot". Please log in via Settings.',
        ),
      ),
    ).toBe(true);
    expect(
      isTransientProviderError(
        new Error('OAuth refresh failed for github-copilot: 401 Unauthorized'),
      ),
    ).toBe(true);
  });

  it('classifies network / gateway failures as transient', () => {
    expect(isTransientProviderError(new Error('fetch failed'))).toBe(true);
    expect(
      isTransientProviderError(
        new Error('Connect Timeout Error (attempted address: github.com:443)'),
      ),
    ).toBe(true);
    expect(isTransientProviderError(new Error('503 Service Unavailable'))).toBe(
      true,
    );
  });

  it('treats a genuine "model returned unparseable output" as non-transient', () => {
    expect(
      isTransientProviderError(
        new SyntaxError('Unexpected token < in JSON at position 0'),
      ),
    ).toBe(false);
    expect(isTransientProviderError(new Error('empty response'))).toBe(false);
  });
});
