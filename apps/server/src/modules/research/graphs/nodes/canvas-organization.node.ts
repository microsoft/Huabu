/**
 * Canvas Organization Node
 *
 * Final step: wraps all research nodes in a frame and sets final state.
 */

import { AIMessage } from '@langchain/core/messages';

import { getCanvasOperationService } from '../../../canvas/canvas.operation.js';

import type { ResearchState } from '../research.state.js';

function progressMsg(
  content: string,
  toolResponseData: Record<string, unknown>,
  status: 'success' | 'error' = 'success',
) {
  return new AIMessage({
    content,
    additional_kwargs: {
      toolResponse: {
        tool: 'research_canvas_organization',
        status,
        data: toolResponseData,
      },
    },
  });
}

/**
 * Canvas Organization Node
 *
 * Wraps all research nodes in a frame for better organization.
 * Appends an AIMessage (toolResponse) so the agent can stream structured progress.
 */
export async function canvasOrganizationNode(
  state: typeof ResearchState.State,
): Promise<Partial<typeof ResearchState.State>> {
  console.log('[canvasOrganizationNode] Organizing canvas');

  const canvasService = getCanvasOperationService();

  // Skip frame creation if disabled in config
  if (state.config?.groupWithFrame === false) {
    console.log('[canvasOrganizationNode] Frame creation disabled');
    return {
      endTime: Date.now(),
      finalCanvasVersion: state.canvasVersion + 1,
      messages: [
        progressMsg('Research complete.', {
          nodeCount: state.createdNodeIds.length,
          grouped: false,
        }),
      ],
    };
  }

  // Get all created node IDs
  const allNodeIds = Array.from(new Set(state.createdNodeIds));

  if (allNodeIds.length === 0) {
    console.log('[canvasOrganizationNode] No nodes to organize');
    return {
      endTime: Date.now(),
      finalCanvasVersion: state.canvasVersion,
      messages: [
        progressMsg('Research complete (no nodes created).', {
          nodeCount: 0,
          grouped: false,
        }),
      ],
    };
  }

  try {
    // Calculate position for frame
    const layoutResult = await canvasService.calculateLayout({
      canvasId: state.canvasId,
      placementStrategy: state.config?.placement ?? 'auto',
      nodeCount: 1,
      padding: state.config?.padding,
    });

    const frameLabel = `🔬 ${state.query.slice(0, 40)}${
      state.query.length > 40 ? '...' : ''
    }`;
    const frameResult = await canvasService.createFrame({
      canvasId: state.canvasId,
      label: frameLabel,
      position: {
        x: layoutResult.startPosition.x - 50,
        y: layoutResult.startPosition.y - 50,
      },
      childNodeIds: allNodeIds,
      data: {
        origin: 'research',
        research: { query: state.query, threadId: state.threadId },
      },
      size: { width: 900, height: 700 },
    });

    console.log('[canvasOrganizationNode] Created frame:', frameResult.nodeId);

    return {
      frameId: frameResult.nodeId,
      endTime: Date.now(),
      finalCanvasVersion: state.canvasVersion + 1,
      messages: [
        progressMsg(`Organized ${allNodeIds.length} node(s) into a frame.`, {
          frameId: frameResult.nodeId,
          nodeCount: allNodeIds.length,
          grouped: true,
        }),
      ],
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[canvasOrganizationNode] Error:', errMsg);

    return {
      errors: [`Canvas organization failed: ${errMsg}`],
      endTime: Date.now(),
      finalCanvasVersion: state.canvasVersion + 1,
      messages: [
        new AIMessage({
          content: 'Canvas organization failed.',
          additional_kwargs: {
            toolResponse: {
              tool: 'research_canvas_organization',
              status: 'error',
              error: errMsg,
            },
          },
        }),
      ],
    };
  }
}
