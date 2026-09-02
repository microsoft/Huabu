// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Hosted `web-search` capability service — Tavily-backed internet
 * search shared by the native `web_search` tool adapter
 * (`../tools/handlers/web-search.ts`) and the external RFS
 * hosted-capability invocation adapter described in
 * docs/proposals/agent-resource-registry.md §11.
 *
 * Owns:
 *   - the canonical `web-search` capability ID (`./capability-ids.ts`);
 *   - server-side SecretStore credential resolution (Tavily API key) —
 *     the caller can never select a provider, endpoint, or credential;
 *   - bounded input validation;
 *   - the provider timeout/cancellation contract;
 *   - sanitized, stable errors (`./errors.ts`);
 *   - result shaping (`{ query, answer?, results[] }`) independent of
 *     any particular caller's wire envelope, so the RFS adapter
 *     can reuse it directly.
 *
 * This module has no canvas dependency — web search bounds are purely
 * request-shaped (query / result count / depth), unlike image
 * generation's Canvas-scoped artifact persistence.
 */

import {
  webSearchInvocationInputSchema,
  type WebSearchInvocationInput,
} from '@huabu/shared';

import { classifyAbort, createTimeoutController } from './cancellation.js';
import { HOSTED_CAPABILITY_IDS } from './capability-ids.js';
import { HostedCapabilityError } from './errors.js';
import { getLogger } from '../../../utils/logger.js';
import { getTavilyApiKey } from '../../integrations/integrations.js';

import type { HostedCapabilityInvocationOptions } from './types.js';

const log = getLogger('hosted-capability.web-search');

/** Bounded provider deadline (docs/proposals/agent-resource-registry.md §13). */
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESULT_TITLE_LENGTH = 500;
const MAX_RESULT_URL_LENGTH = 4_096;
const MAX_RESULT_CONTENT_LENGTH = 12_000;
const MAX_ANSWER_LENGTH = 12_000;
const MAX_QUERY_LENGTH = 4_000;
export const WEB_SEARCH_CAPABILITY_ID = HOSTED_CAPABILITY_IDS.webSearch;

export type { HostedCapabilityInvocationOptions } from './types.js';
export type { WebSearchInvocationInput } from '@huabu/shared';

export interface WebSearchResultItem {
  title: string;
  url: string;
  content: string;
  favicon: string;
  score?: number;
}

export interface WebSearchInvocationResult {
  query: string;
  answer?: string;
  results: WebSearchResultItem[];
}

function validateInput(
  input: WebSearchInvocationInput,
): WebSearchInvocationInput {
  const parsed = webSearchInvocationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new HostedCapabilityError(
      'invalid_input',
      parsed.error.issues[0]?.message ?? 'Invalid web search input.',
    );
  }
  return parsed.data;
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

/**
 * Invoke the hosted `web-search` capability.
 *
 * Always throws {@link HostedCapabilityError} on failure — missing
 * credentials (`unavailable`), invalid input (`invalid_input`), a
 * provider deadline or caller cancellation (`timeout` /
 * `cancelled`), or any other transport/non-2xx failure
 * (`provider_failure`). Never returns a success-shaped result on
 * error (docs/proposals/agent-resource-registry.md §14).
 */
export async function invokeWebSearch(
  input: WebSearchInvocationInput,
  options: HostedCapabilityInvocationOptions = {},
): Promise<WebSearchInvocationResult> {
  input = validateInput(input);

  const apiKey = getTavilyApiKey();
  if (!apiKey) {
    throw new HostedCapabilityError(
      'unavailable',
      'Missing Tavily API key. Add it in Settings → Integrations (or set TAVILY_API_KEY) to enable web_search.',
    );
  }

  const timeout = createTimeoutController({
    timeoutMs: REQUEST_TIMEOUT_MS,
    signal: options.signal,
  });

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: input.query,
        search_depth: input.searchDepth ?? 'basic',
        max_results: input.maxResults ?? 5,
        include_answer: input.includeAnswer ?? true,
        include_raw_content: false,
      }),
      signal: timeout.signal,
    });

    if (!response.ok) {
      throw new Error(`Tavily request failed with status ${response.status}.`);
    }

    const data = (await response.json()) as {
      answer?: string;
      query?: string;
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        score?: number;
        favicon?: string;
      }>;
    };

    const results: WebSearchResultItem[] = (data.results ?? [])
      .filter((r) => typeof r?.url === 'string' && r.url.length > 0)
      .slice(0, input.maxResults ?? 5)
      .map((r) => ({
        title: boundedText(r.title, MAX_RESULT_TITLE_LENGTH),
        url: boundedText(r.url, MAX_RESULT_URL_LENGTH),
        content: boundedText(r.content, MAX_RESULT_CONTENT_LENGTH),
        favicon: boundedText(r.favicon, MAX_RESULT_URL_LENGTH),
        score: Number.isFinite(r.score) ? r.score : undefined,
      }));

    return {
      query: boundedText(data.query, MAX_QUERY_LENGTH) || input.query,
      ...(typeof data.answer === 'string'
        ? { answer: boundedText(data.answer, MAX_ANSWER_LENGTH) }
        : {}),
      results,
    };
  } catch (error) {
    if (error instanceof HostedCapabilityError) throw error;
    log.warn({ err: error }, 'Tavily request failed');
    const isAbort =
      error instanceof DOMException && error.name === 'AbortError';
    const code = isAbort
      ? classifyAbort(timeout, options.signal)
      : 'provider_failure';
    throw new HostedCapabilityError(code, 'Tavily request failed.');
  } finally {
    timeout.clear();
  }
}
