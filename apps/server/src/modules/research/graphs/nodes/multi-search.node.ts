/**
 * Multi-Search Node
 *
 * Executes web searches for each sub-query and creates canvas nodes for results.
 */

import { AIMessage } from '@langchain/core/messages';

import { webSearchTool } from '../../../agent/tools/web_search.js';
import { getCanvasOperationService } from '../../../canvas/canvas.operation.js';

import type { ResearchState } from '../research.state.js';
import type {
  SearchResult,
  WebSearchToolResponse,
  Point,
} from '@sediment/shared';

/**
 * Multi-Search Node
 * 
 * For each sub-query:
 * 1. Call web search tool
 * 2. Create canvas node for each result
 3. Track search results
 */
export async function multiSearchNode(
  state: typeof ResearchState.State,
): Promise<Partial<typeof ResearchState.State>> {
  console.log('[multiSearchNode] Searching for queries:', state.subQueries);

  const searchResults: SearchResult[] = [];
  const createdNodeIds: string[] = [];
  const canvasService = getCanvasOperationService();

  // Calculate layout for first node
  const layoutResult = await canvasService.calculateLayout({
    canvasId: state.canvasId,
    placementStrategy: state.config?.placement ?? 'auto',
    nodeCount: state.subQueries.length * 3, // Estimate
    padding: state.config?.padding,
  });

  const currentPosition: Point = layoutResult.startPosition;
  const spacing = 300;

  for (const query of state.subQueries) {
    try {
      console.log('[multiSearchNode] Searching:', query);

      // Call web search tool
      const searchResultRaw = await webSearchTool.invoke({
        query,
        max_results: 3,
        search_depth: state.config?.searchDepth ?? 'advanced',
        include_answer: false,
      });

      // Parse tool response
      let searchResponse: WebSearchToolResponse;
      try {
        searchResponse = JSON.parse(searchResultRaw) as WebSearchToolResponse;
      } catch {
        console.error('[multiSearchNode] Failed to parse search result');
        continue;
      }

      if (searchResponse.status !== 'success') {
        console.warn('[multiSearchNode] Search failed:', searchResponse.error);
        continue;
      }

      // Create canvas node for each result
      const results = searchResponse.data.results ?? [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i];

        // Create web node with proper size
        const { nodeId } = await canvasService.createNode({
          canvasId: state.canvasId,
          position: {
            x: currentPosition.x + (i % 3) * spacing,
            y: currentPosition.y + Math.floor(i / 3) * 250,
          },
          data: {
            type: 'web',
            src: result.url,
            label: result.title,
            origin: { type: 'research' },
            research: {
              query: state.query,
              threadId: state.threadId,
            },
          },
          size: { width: 280, height: 200 },
        });

        searchResults.push({
          query,
          nodeId,
          url: result.url,
          title: result.title,
          content: result.content,
        });

        createdNodeIds.push(nodeId);
      }

      // Move position down for next query's results
      const rows = Math.ceil(results.length / 3);
      currentPosition.y += rows * 250 + 50;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[multiSearchNode] Error searching:', query, message);
    }
  }

  console.log('[multiSearchNode] Created nodes:', createdNodeIds.length);

  const progressMessage = new AIMessage({
    content: `Found ${createdNodeIds.length} source(s) across ${searchResults.length} search result(s).`,
    additional_kwargs: {
      toolResponse: {
        tool: 'research_multi_search',
        status: 'success',
        data: {
          nodeCount: createdNodeIds.length,
          resultCount: searchResults.length,
          queries: state.subQueries,
        },
      },
    },
  });

  return {
    searchResults,
    createdNodeIds,
    messages: [progressMessage],
  };
}
