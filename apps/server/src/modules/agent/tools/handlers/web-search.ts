// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `web_search` handler — Tavily-backed internet search.
 *
 * Has no canvas dependency, so it lives in its own file rather than
 * lumped together with canvas-aware handlers.
 *
 * This is now a thin adapter over the shared hosted-capability service
 * in `../../hosted-capabilities/web-search.service.ts`. That service
 * owns credential resolution, input validation, the provider
 * timeout/cancellation contract, and error sanitization; the same
 * service will back the external RFS hosted-capability invocation
 * adapter (docs/proposals/agent-resource-registry.md §11), so native
 * and external callers share one implementation.
 *
 * Errors throw — pi-agent-core catches and surfaces them as
 * `isError: true` tool results (see its `AgentTool.execute` contract).
 * `HostedCapabilityError extends Error`, so the service's sanitized
 * `.message` propagates unchanged; native behavior is therefore
 * identical to before the extraction.
 * On success we return the inner payload (`{ query, answer, results }`)
 * directly; the SSE bridge / web client wraps it into the standard
 * `ToolResponse<'web_search', WebSearchToolData>` envelope.
 */

import { invokeWebSearch } from '../../hosted-capabilities/web-search.service.js';

import type { webSearchParamsSchema } from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

export type WebSearchArgs = Static<typeof webSearchParamsSchema>;

export async function handleWebSearch(args: WebSearchArgs): Promise<string> {
  const result = await invokeWebSearch({
    query: args.query,
    maxResults: args.max_results,
    searchDepth: args.search_depth,
    includeAnswer: args.include_answer,
  });
  return JSON.stringify(result);
}
