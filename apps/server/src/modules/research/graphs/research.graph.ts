/**
 * Research Graph
 *
 * Orchestrates the deep research workflow:
 * 1. Query Analysis: Decompose query into sub-queries
 * 2. Multi-Search: Execute searches and create canvas nodes
 * 3. Ingestion: Trigger content ingestion (MVP: skip)
 * 4. Synthesis: Generate AI insights from results
 * 5. Canvas Organization: Wrap nodes in a frame
 */

import { END, START, StateGraph } from '@langchain/langgraph';

import { canvasOrganizationNode } from './nodes/canvas-organization.node.js';
import { ingestionNode } from './nodes/ingestion.node.js';
import { multiSearchNode } from './nodes/multi-search.node.js';
import { queryAnalysisNode } from './nodes/query-analysis.node.js';
import { synthesisNode } from './nodes/synthesis.node.js';
import { ResearchState } from './research.state.js';
import { getCheckpointer } from '../../agent/store/index.js';

/**
 * Create Research Graph
 *
 * Defines the workflow for deep research on canvas.
 * Uses a SQLite-backed checkpointer so each research session's state is
 * persisted and can be inspected or resumed after an interruption.
 */
async function createResearchGraph() {
  const checkpointer = await getCheckpointer();

  // Build graph
  const graph = new StateGraph(ResearchState)
    // Add all nodes
    .addNode('query-analysis', queryAnalysisNode)
    .addNode('multi-search', multiSearchNode)
    .addNode('ingestion', ingestionNode)
    .addNode('synthesis', synthesisNode)
    .addNode('canvas-organization', canvasOrganizationNode)

    // Define flow
    .addEdge(START, 'query-analysis')
    .addEdge('query-analysis', 'multi-search')
    .addEdge('multi-search', 'ingestion')
    .addEdge('ingestion', 'synthesis')
    .addEdge('synthesis', 'canvas-organization')
    .addEdge('canvas-organization', END);

  return graph.compile({ checkpointer });
}

/**
 * Get singleton instance (lazy-initialised, async)
 */
let researchGraphPromise: ReturnType<typeof createResearchGraph> | null = null;

export function getResearchGraph(): ReturnType<typeof createResearchGraph> {
  if (!researchGraphPromise) {
    researchGraphPromise = createResearchGraph();
  }
  return researchGraphPromise;
}
