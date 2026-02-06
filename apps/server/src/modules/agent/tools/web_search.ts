import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import type { WebSearchToolResponse } from '@sediment/shared';

const toToolOutput = (payload: WebSearchToolResponse) => {
  return JSON.stringify(payload);
};

export const webSearchTool = tool(
  async ({ query, max_results, search_depth, include_answer }) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      const payload = {
        tool: 'web_search',
        status: 'error',
        error: 'Missing TAVILY_API_KEY in environment variables.',
        hint: 'Set TAVILY_API_KEY (for example in apps/server/.env) to enable web_search.',
      } satisfies WebSearchToolResponse;
      return toToolOutput(payload);
    }

    const controller = new AbortController();
    const timeoutMs = 15_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: search_depth ?? 'basic',
          max_results: max_results ?? 5,
          include_answer: include_answer ?? true,
          include_raw_content: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (text) {
          console.warn('[web_search] Tavily error response:', text);
        }
        const payload = {
          tool: 'web_search',
          status: 'error',
          error: `Tavily request failed with status ${response.status}.`,
        } satisfies WebSearchToolResponse;
        return toToolOutput(payload);
      }

      const data = (await response.json()) as {
        answer?: string;
        query?: string;
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
          raw_content?: string;
          score?: number;
          favicon?: string;
        }>;
      };

      const normalizedResults = (data.results ?? [])
        .filter((r) => typeof r?.url === 'string' && r.url.length > 0)
        .map((r) => ({
          title: r.title ?? '',
          url: r.url ?? '',
          content: r.content ?? r.raw_content ?? '',
          favicon: r.favicon ?? '',
          score: typeof r.score === 'number' ? r.score : undefined,
        }));

      const payload = {
        tool: 'web_search',
        status: 'success',
        data: {
          query: data.query ?? query,
          answer: data.answer,
          results: normalizedResults,
        },
      } satisfies WebSearchToolResponse;
      return toToolOutput(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message) {
        console.warn('[web_search] Tavily request failed:', message);
      }
      const payload = {
        tool: 'web_search',
        status: 'error',
        error: 'Tavily request failed.',
      } satisfies WebSearchToolResponse;
      return toToolOutput(payload);
    } finally {
      clearTimeout(timeout);
    }
  },
  {
    name: 'web_search',
    description:
      'Search the internet for up-to-date facts and documentation using Tavily.',
    schema: z.object({
      query: z.string().describe('The search query keywords'),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Maximum number of results (1-10). Default: 5.'),
      search_depth: z
        .enum(['basic', 'advanced'])
        .optional()
        .describe("Search depth. Default: 'basic'."),
      include_answer: z
        .boolean()
        .optional()
        .describe('Whether to include Tavily answer summary. Default: true.'),
    }),
  },
);
