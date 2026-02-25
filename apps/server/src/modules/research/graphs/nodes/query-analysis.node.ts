/**
 * Query Analysis Node
 *
 * Analyzes the research query and decomposes it into sub-queries for focused searching.
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { getLLM } from '../../../agent/llm.js';
import { getMaxSources } from '../../utils.js';

import type { ResearchState } from '../research.state.js';

const QUERY_ANALYSIS_PROMPT = `You are a research analyst. Analyze the given research query and break it down into 2-4 focused sub-queries that will help gather comprehensive information.

Guidelines:
- Each sub-query should target a specific aspect of the main query
- Use concrete, searchable terms
- Keep queries focused and specific
- Return ONLY a JSON array of strings, no other text

Example:
Input: "Analyze Web3 applications in supply chain management"
Output: ["Web3 supply chain implementations", "blockchain supply chain case studies", "Web3 supply chain challenges solutions"]

Now analyze this query:`;

/**
 * Query Analysis Node
 *
 * Takes the research query and generates sub-queries for more focused searching.
 */
export async function queryAnalysisNode(
  state: typeof ResearchState.State,
): Promise<Partial<typeof ResearchState.State>> {
  console.log('[queryAnalysisNode] Analyzing query:', state.query);

  const llm = getLLM();

  try {
    const response = await llm.invoke([
      new SystemMessage(QUERY_ANALYSIS_PROMPT),
      new HumanMessage(state.query),
    ]);

    const content =
      typeof response.content === 'string' ? response.content : '';

    // Try to parse JSON response
    let subQueries: string[] = [];
    try {
      const jsonMatch = content.match(/\[.*\]/s);
      if (jsonMatch) {
        subQueries = JSON.parse(jsonMatch[0]) as string[];
      }
    } catch {
      console.warn('[queryAnalysisNode] Failed to parse JSON, using fallback');
      // Fallback: use original query
      subQueries = [state.query];
    }

    // Limit based on search depth (basic: 4 sources, advanced: 8 sources)
    const maxSources = getMaxSources(state.config);
    subQueries = subQueries.slice(0, Math.max(maxSources - 2, 1));

    console.log('[queryAnalysisNode] Generated sub-queries:', subQueries);

    return {
      subQueries,
      messages: [response],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[queryAnalysisNode] Error:', message);

    // Fallback: use original query
    return {
      subQueries: [state.query],
      errors: [`Query analysis failed: ${message}`],
    };
  }
}
