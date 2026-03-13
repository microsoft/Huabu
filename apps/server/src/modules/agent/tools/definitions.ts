/**
 * Tool Definitions for the Unified Agent
 *
 * All tools the AI can call across chat, research, and agent modes.
 * Each tool is a pi-ai Tool with a TypeBox schema for validation.
 */

import { Type } from '@mariozechner/pi-ai';

import type { Tool } from '@mariozechner/pi-ai';

// ==================== Web Search ====================

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the internet for up-to-date facts, documentation, or news using Tavily.',
  parameters: Type.Object({
    query: Type.String({ description: 'The search query keywords' }),
    max_results: Type.Optional(
      Type.Number({
        description: 'Maximum number of results (1-10). Default: 5.',
        minimum: 1,
        maximum: 10,
      }),
    ),
    search_depth: Type.Optional(
      Type.Union([Type.Literal('basic'), Type.Literal('advanced')], {
        description: "Search depth. Default: 'basic'.",
      }),
    ),
    include_answer: Type.Optional(
      Type.Boolean({
        description: 'Whether to include Tavily answer summary. Default: true.',
      }),
    ),
  }),
};

// ==================== Canvas Node Tools ====================

export const getNodeDetailTool: Tool = {
  name: 'get_node_detail',
  description:
    'Get the full content and metadata of a specific canvas node by its ID.',
  parameters: Type.Object({
    nodeId: Type.String({ description: 'The ID of the canvas node to read' }),
    canvasId: Type.String({ description: 'The canvas ID' }),
  }),
};

export const getCanvasStateTool: Tool = {
  name: 'get_canvas_state',
  description:
    'Get a summary of the current canvas state including all nodes, edges, and frames.',
  parameters: Type.Object({
    canvasId: Type.String({ description: 'The canvas ID' }),
  }),
};

export const createNodeTool: Tool = {
  name: 'create_node',
  description:
    'Create a new node on the canvas. Use this to add notes, text, web links, or other content.',
  parameters: Type.Object({
    canvasId: Type.String({ description: 'The canvas ID' }),
    nodeType: Type.Union(
      [
        Type.Literal('note'),
        Type.Literal('text'),
        Type.Literal('web'),
        Type.Literal('image'),
        Type.Literal('pdf'),
        Type.Literal('video'),
      ],
      { description: 'The type of node to create' },
    ),
    label: Type.Optional(
      Type.String({ description: 'Display label for the node' }),
    ),
    content: Type.Optional(
      Type.String({ description: 'Text content for note/text nodes' }),
    ),
    src: Type.Optional(
      Type.String({
        description: 'Source URL for web/image/pdf/video nodes',
      }),
    ),
    position: Type.Optional(
      Type.Object(
        {
          x: Type.Number(),
          y: Type.Number(),
        },
        { description: 'Position on canvas. Omit for auto-placement.' },
      ),
    ),
  }),
};

export const updateNodeTool: Tool = {
  name: 'update_node',
  description:
    'Update the data of an existing canvas node (label, content, etc.).',
  parameters: Type.Object({
    canvasId: Type.String({ description: 'The canvas ID' }),
    nodeId: Type.String({ description: 'The node ID to update' }),
    label: Type.Optional(Type.String({ description: 'New label' })),
    content: Type.Optional(Type.String({ description: 'New content' })),
  }),
};

export const deleteNodesTool: Tool = {
  name: 'delete_nodes',
  description: 'Delete one or more nodes from the canvas.',
  parameters: Type.Object({
    canvasId: Type.String({ description: 'The canvas ID' }),
    nodeIds: Type.Array(Type.String(), {
      description: 'Array of node IDs to delete',
    }),
  }),
};

// ==================== Edge Tools ====================

export const connectNodesTool: Tool = {
  name: 'connect_nodes',
  description: 'Create an edge connecting two canvas nodes.',
  parameters: Type.Object({
    canvasId: Type.String({ description: 'The canvas ID' }),
    sourceId: Type.String({ description: 'Source node ID' }),
    targetId: Type.String({ description: 'Target node ID' }),
  }),
};

export const disconnectNodesTool: Tool = {
  name: 'disconnect_nodes',
  description: 'Remove the edge between two canvas nodes.',
  parameters: Type.Object({
    canvasId: Type.String({ description: 'The canvas ID' }),
    sourceId: Type.String({ description: 'Source node ID' }),
    targetId: Type.String({ description: 'Target node ID' }),
  }),
};

// ==================== Frame Tools ====================

export const createFrameTool: Tool = {
  name: 'create_frame',
  description: 'Group nodes into a frame on the canvas.',
  parameters: Type.Object({
    canvasId: Type.String({ description: 'The canvas ID' }),
    nodeIds: Type.Array(Type.String(), {
      description: 'Node IDs to group into the frame',
    }),
    frameLabel: Type.Optional(
      Type.String({ description: 'Label for the frame' }),
    ),
  }),
};

// ==================== Knowledge Tools ====================

export const readSourceTool: Tool = {
  name: 'read_source',
  description: 'Read the full content of a knowledge source by its source ID.',
  parameters: Type.Object({
    sourceId: Type.String({
      description: 'The knowledge base source ID to read',
    }),
  }),
};

export const searchKnowledgeTool: Tool = {
  name: 'search_knowledge',
  description:
    'Search the knowledge base for sources matching a query (by title or content keywords).',
  parameters: Type.Object({
    query: Type.String({ description: 'Search query' }),
  }),
};

export const ingestContentTool: Tool = {
  name: 'ingest_content',
  description:
    'Trigger content ingestion for a canvas node, loading its web/PDF content into the knowledge base.',
  parameters: Type.Object({
    canvasId: Type.String({ description: 'The canvas ID' }),
    nodeId: Type.String({
      description: 'The node ID to trigger ingestion for',
    }),
  }),
};

// ==================== Tool Sets by Mode ====================

/**
 * Tools available in chat mode.
 * Limited to search and read-only canvas/knowledge access.
 */
export const chatTools: Tool[] = [webSearchTool];

/**
 * Tools available in research mode.
 * Extends chat tools with node creation, ingestion, and organization.
 */
export const researchTools: Tool[] = [
  webSearchTool,
  getCanvasStateTool,
  getNodeDetailTool,
  createNodeTool,
  updateNodeTool,
  createFrameTool,
  readSourceTool,
  ingestContentTool,
];

/**
 * Tools available in agent mode.
 * Full set of canvas manipulation tools for intent execution.
 */
export const agentTools: Tool[] = [
  webSearchTool,
  getCanvasStateTool,
  getNodeDetailTool,
  createNodeTool,
  updateNodeTool,
  deleteNodesTool,
  connectNodesTool,
  disconnectNodesTool,
  createFrameTool,
  readSourceTool,
  searchKnowledgeTool,
  ingestContentTool,
];
