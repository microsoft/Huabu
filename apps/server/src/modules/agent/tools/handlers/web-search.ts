/**
 * `web_search` handler — Tavily-backed internet search.
 *
 * Has no canvas dependency, so it lives in its own file rather than
 * lumped together with canvas-aware handlers.
 *
 * Errors throw — pi-agent-core catches and surfaces them as
 * `isError: true` tool results (see its `AgentTool.execute` contract).
 * On success we return the inner payload (`{ query, answer, results }`)
 * directly; the SSE bridge / web client wraps it into the standard
 * `ToolResponse<'web_search', WebSearchToolData>` envelope.
 */

import type { webSearchParamsSchema } from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

export type WebSearchArgs = Static<typeof webSearchParamsSchema>;

export async function handleWebSearch(args: WebSearchArgs): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing TAVILY_API_KEY in environment variables. Set TAVILY_API_KEY in the repo-root .env to enable web_search.',
    );
  }

  const controller = new AbortController();
  const timeoutMs = 15_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: args.query,
        search_depth: args.search_depth ?? 'basic',
        max_results: args.max_results ?? 5,
        include_answer: args.include_answer ?? true,
        include_raw_content: false,
      }),
      signal: controller.signal,
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

    const results = (data.results ?? [])
      .filter((r) => typeof r?.url === 'string' && r.url.length > 0)
      .map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        content: r.content ?? '',
        favicon: r.favicon ?? '',
        score: typeof r.score === 'number' ? r.score : undefined,
      }));

    return JSON.stringify({
      query: data.query ?? args.query,
      answer: data.answer,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[web_search] Tavily request failed:', message);
    throw new Error(`Tavily request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}
