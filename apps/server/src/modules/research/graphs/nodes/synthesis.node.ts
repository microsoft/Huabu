/**
 * Synthesis Node
 *
 * Uses LLM to synthesize insights from search results and creates note nodes.
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { getLLM } from '../../../agent/llm.js';
import { getCanvasOperationService } from '../../../canvas/canvas.operation.js';

import type { ResearchState } from '../research.state.js';

const SYNTHESIS_PROMPT = `You are a research analyst. Based on the search results provided, create a concise synthesis that:
1. Identifies key themes and patterns
2. Highlights the most important findings
3. Notes any contradictions or gaps

Keep your synthesis focused and actionable. Use markdown formatting.

Limit: 300 words maximum.`;

/**
 * Synthesis Node
 *
 * Analyzes all search results and creates synthesis note nodes.
 */
export async function synthesisNode(
  state: typeof ResearchState.State,
): Promise<Partial<typeof ResearchState.State>> {
  console.log(
    '[synthesisNode] Synthesizing results:',
    state.searchResults.length,
  );

  if (state.searchResults.length === 0) {
    console.log('[synthesisNode] No results to synthesize');
    return { synthesisNodeIds: [] };
  }

  const llm = getLLM();
  const canvasService = getCanvasOperationService();
  const synthesisNodeIds: string[] = [];

  // Build context from search results
  const context = state.searchResults
    .map((result, i) => {
      const snippet = (result.content ?? '').slice(0, 300);
      return `[${i + 1}] ${result.title}\n${result.url}\n${snippet}...`;
    })
    .join('\n\n');

  try {
    const response = await llm.invoke([
      new SystemMessage(SYNTHESIS_PROMPT),
      new HumanMessage(
        `Research Query: ${state.query}\n\nSearch Results:\n\n${context}\n\nProvide your synthesis:`,
      ),
    ]);

    const synthesis =
      typeof response.content === 'string' ? response.content : '';

    console.log(
      '[synthesisNode] Generated synthesis:',
      synthesis.slice(0, 100),
    );

    // Calculate position (below all search nodes)
    const layoutResult = await canvasService.calculateLayout({
      canvasId: state.canvasId,
      placementStrategy: state.config?.placement ?? 'auto',
      nodeCount: 1,
      padding: state.config?.padding,
    });

    // Adjust position to be below search results
    const position = {
      x: layoutResult.startPosition.x,
      y:
        layoutResult.startPosition.y +
        Math.ceil(state.searchResults.length / 3) * 250 +
        100,
    };

    // Create synthesis node
    const { nodeId } = await canvasService.createNode({
      canvasId: state.canvasId,
      position,
      data: {
        type: 'note',
        content: synthesis,
        label: `💡 Synthesis: ${state.query.slice(0, 30)}...`,
        origin: 'research',
        research: {
          query: state.query,
          sessionId: state.sessionId,
          relatedNodeIds: state.createdNodeIds,
        },
      },
      size: { width: 400, height: 300 },
    });

    synthesisNodeIds.push(nodeId);

    console.log('[synthesisNode] Created synthesis node:', nodeId);

    return {
      synthesisNodeIds,
      createdNodeIds: [nodeId],
      messages: [response],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[synthesisNode] Error:', message);

    return {
      errors: [`Synthesis failed: ${message}`],
    };
  }
}
