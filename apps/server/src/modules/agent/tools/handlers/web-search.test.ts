// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Parity tests for the `web_search` native tool adapter.
 *
 * The handler body was extracted into the shared hosted-capability
 * service (`../../hosted-capabilities/web-search.service.ts`); these
 * tests pin that the adapter still maps pi-ai tool args onto the
 * service's input contract 1:1, still returns the same JSON string
 * wire shape, and still lets a service error propagate unchanged so
 * native behavior is identical to before the extraction.
 */

import { describe, expect, it, vi } from 'vitest';

const invokeWebSearch = vi.fn();

vi.mock('../../hosted-capabilities/web-search.service.js', () => ({
  invokeWebSearch: (...args: unknown[]) => invokeWebSearch(...args),
}));

const { handleWebSearch } = await import('./web-search.js');

describe('handleWebSearch', () => {
  it('maps tool args onto the hosted-capability service input contract', async () => {
    invokeWebSearch.mockResolvedValue({
      query: 'foo',
      answer: 'bar',
      results: [],
    });

    await handleWebSearch({
      query: 'foo',
      max_results: 3,
      search_depth: 'advanced',
      include_answer: false,
    });

    expect(invokeWebSearch).toHaveBeenCalledWith({
      query: 'foo',
      maxResults: 3,
      searchDepth: 'advanced',
      includeAnswer: false,
    });
  });

  it('returns the service result as a JSON string, unwrapped', async () => {
    const serviceResult = { query: 'foo', answer: undefined, results: [] };
    invokeWebSearch.mockResolvedValue(serviceResult);

    const raw = await handleWebSearch({ query: 'foo' });

    expect(raw).toBe(JSON.stringify(serviceResult));
    expect(JSON.parse(raw)).toEqual({ query: 'foo', results: [] });
  });

  it('propagates a service error unchanged (native error-message contract)', async () => {
    invokeWebSearch.mockRejectedValue(new Error('Tavily request failed: boom'));

    await expect(handleWebSearch({ query: 'foo' })).rejects.toThrow(
      'Tavily request failed: boom',
    );
  });
});
