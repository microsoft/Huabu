/**
 * Ingestion Node
 *
 * Triggers content ingestion for web nodes created during search.
 */

import { AIMessage } from '@langchain/core/messages';

import { getCanvasOperationService } from '../../../canvas/canvas.operation.js';
import { getIngestService } from '../../../knowledge/ingest.service.js';

import type { ResearchState } from '../research.state.js';

/**
 * Ingestion Node
 *
 * Ingests content for web nodes:
 * 1. Trigger knowledge ingestion for each search result
 * 2. Update node data with sourceId
 */
export async function ingestionNode(
  state: typeof ResearchState.State,
): Promise<Partial<typeof ResearchState.State>> {
  console.log(
    '[ingestionNode] Ingesting content for:',
    state.searchResults.length,
    'results',
  );

  if (state.searchResults.length === 0) {
    console.log('[ingestionNode] No results to ingest');
    return {};
  }

  const ingestService = await getIngestService();
  const canvasService = getCanvasOperationService();
  const errors: string[] = [];

  // Ingest each search result
  for (const result of state.searchResults) {
    try {
      console.log('[ingestionNode] Ingesting:', result.url);

      // Trigger ingestion
      const outcome = await ingestService.ingestCanvasNode({
        workspaceId: 'default',
        nodeId: result.nodeId,
        type: 'web',
        title: result.title,
        src: result.url,
      });

      if (!outcome.success) {
        console.warn(
          '[ingestionNode] Ingestion failed:',
          outcome.error?.message,
        );
        errors.push(
          `Failed to ingest ${result.url}: ${outcome.error?.message}`,
        );
        continue;
      }

      // Update node with sourceId so WebNode component can load preview
      await canvasService.updateNodeData(state.canvasId, result.nodeId, {
        sourceId: outcome.sourceId,
      });

      console.log(
        '[ingestionNode] Successfully ingested:',
        result.nodeId,
        'sourceId:',
        outcome.sourceId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[ingestionNode] Error ingesting:', result.url, message);
      errors.push(`Failed to ingest ${result.url}: ${message}`);
    }
  }

  console.log(
    '[ingestionNode] Completed:',
    state.searchResults.length - errors.length,
    'succeeded,',
    errors.length,
    'failed',
  );

  const succeeded = state.searchResults.length - errors.length;
  const progressMessage = new AIMessage({
    content: `Content ingestion complete: ${succeeded} succeeded, ${errors.length} failed.`,
    additional_kwargs: {
      toolResponse: {
        tool: 'research_ingestion',
        status: errors.length > 0 ? 'error' : 'success',
        data: { succeeded, failed: errors.length },
        ...(errors.length > 0 ? { error: errors[0] } : {}),
      },
    },
  });

  return {
    messages: [progressMessage],
    ...(errors.length > 0 ? { errors } : {}),
  };
}
