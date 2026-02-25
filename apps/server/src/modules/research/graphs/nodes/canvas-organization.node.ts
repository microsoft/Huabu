/**
 * Canvas Organization Node
 *
 * Final step: wraps all research nodes in a frame and sets final state.
 */

import { getCanvasOperationService } from '../../../canvas/canvas.operation.js';

import type { ResearchState } from '../research.state.js';

/**
 * Canvas Organization Node
 *
 * Wraps all research nodes in a frame for better organization.
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
    };
  }

  // Get all created node IDs
  const allNodeIds = Array.from(new Set(state.createdNodeIds));

  if (allNodeIds.length === 0) {
    console.log('[canvasOrganizationNode] No nodes to organize');
    return {
      endTime: Date.now(),
      finalCanvasVersion: state.canvasVersion,
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

    // Create frame
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
        research: {
          query: state.query,
          sessionId: state.sessionId,
        },
      },
      size: { width: 900, height: 700 },
    });

    console.log('[canvasOrganizationNode] Created frame:', frameResult.nodeId);

    return {
      frameId: frameResult.nodeId,
      endTime: Date.now(),
      finalCanvasVersion: state.canvasVersion + 1,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[canvasOrganizationNode] Error:', message);

    return {
      errors: [`Canvas organization failed: ${message}`],
      endTime: Date.now(),
      finalCanvasVersion: state.canvasVersion + 1,
    };
  }
}
