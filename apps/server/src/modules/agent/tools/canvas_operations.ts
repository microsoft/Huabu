/**
 * Canvas Operations Tools for LangGraph
 *
 * These tools allow the research agent to programmatically create and
 * manipulate canvas nodes during the research process.
 */

import { tool } from '@langchain/core/tools';
import { createId } from '@sediment/shared';
import { z } from 'zod';

import type { CreateNodeResult, CreateEdgeResult } from '@sediment/shared';

// Tool schemas
const CreateNodeSchema = z.object({
  canvasId: z.string().describe('Canvas ID to add the node to'),
  type: z
    .enum(['text', 'web', 'note', 'frame'])
    .describe('Type of node to create'),
  position: z
    .object({ x: z.number(), y: z.number() })
    .describe('Position on the canvas'),
  data: z
    .record(z.string(), z.unknown())
    .describe('Node data (content, src, label, origin, research, etc.)'),
});

const CreateFrameSchema = z.object({
  canvasId: z.string().describe('Canvas ID'),
  label: z.string().describe('Frame title/label'),
  position: z
    .object({ x: z.number(), y: z.number() })
    .describe('Frame position'),
  childNodeIds: z.array(z.string()).describe('Node IDs to wrap in this frame'),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Optional frame data (origin, research, etc.)'),
});

const CreateEdgeSchema = z.object({
  canvasId: z.string().describe('Canvas ID'),
  sourceNodeId: z.string().describe('Source node ID'),
  targetNodeId: z.string().describe('Target node ID'),
  label: z.string().optional().describe('Optional edge label'),
  style: z
    .object({
      stroke: z.string().optional(),
      strokeWidth: z.number().optional(),
      animated: z.boolean().optional(),
    })
    .optional()
    .describe('Optional edge styling'),
});

/**
 * Tool: Create a canvas node
 *
 * This is a placeholder implementation. In the full version, this would:
 * 1. Import CanvasOperationService
 * 2. Call service.createNode()
 * 3. Return the result
 *
 * For now, it returns a mock result to allow graph development to proceed.
 */
export const createCanvasNodeTool = tool(
  async (params) => {
    const { canvasId, type, position } = params;
    // TODO: Implement actual canvas operation
    // const service = getCanvasOperationService();
    // const result = await service.createNode({ canvasId, type, position, data, metadata });

    // Mock implementation for initial development
    const nodeId = createId('node');

    const result: CreateNodeResult = {
      nodeId,
    };

    console.log('[createCanvasNodeTool] Created node:', {
      nodeId,
      type,
      position,
      canvasId,
    });

    return JSON.stringify(result);
  },
  {
    name: 'create_canvas_node',
    description:
      'Create a new node on the canvas. Use this to add research findings, sources, or analysis notes during research.',
    schema: CreateNodeSchema,
  },
);

/**
 * Tool: Create a frame to group nodes
 *
 * Wraps multiple nodes in a visual frame for organization.
 */
export const createCanvasFrameTool = tool(
  async (params) => {
    const { canvasId, label, childNodeIds } = params;
    // TODO: Implement actual canvas operation
    // const service = getCanvasOperationService();
    // const result = await service.createFrame({ canvasId, label, position, childNodeIds, metadata });

    // Mock implementation
    const frameId = createId('frame');

    const result: CreateNodeResult = {
      nodeId: frameId,
    };

    console.log('[createCanvasFrameTool] Created frame:', {
      frameId,
      label,
      childNodeIds,
      canvasId,
    });

    return JSON.stringify(result);
  },
  {
    name: 'create_canvas_frame',
    description:
      'Create a frame to visually group related nodes. Useful for organizing research findings into logical sections.',
    schema: CreateFrameSchema,
  },
);

/**
 * Tool: Create an edge between nodes
 *
 * Connects two nodes with a directed edge.
 */
export const createCanvasEdgeTool = tool(
  async (params) => {
    const { canvasId, sourceNodeId, targetNodeId } = params;
    // TODO: Implement actual canvas operation
    // const service = getCanvasOperationService();
    // const result = await service.createEdge({ canvasId, sourceNodeId, targetNodeId, label, style });

    // Mock implementation
    const edgeId = createId('edge');

    const result: CreateEdgeResult = {
      edgeId,
    };

    console.log('[createCanvasEdgeTool] Created edge:', {
      edgeId,
      sourceNodeId,
      targetNodeId,
      canvasId,
    });

    return JSON.stringify(result);
  },
  {
    name: 'create_canvas_edge',
    description:
      'Create an edge (connection) between two nodes. Use this to show relationships or derivations.',
    schema: CreateEdgeSchema,
  },
);

// Export all canvas tools
export const canvasTools = [
  createCanvasNodeTool,
  createCanvasFrameTool,
  createCanvasEdgeTool,
];
