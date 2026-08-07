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

import { describe, expect, it } from 'vitest';

import { isTransientProviderError } from './provider-manager.js';

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
