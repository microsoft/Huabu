/**
 * Tool Definitions for the Unified Agent
 *
 * All tools the AI can call across ask and operate modes.
 * Each tool is a pi-ai Tool with a TypeBox schema for validation.
 *
 * Definitions here are pure schema + description pairs. The runnable
 * `AgentTool` form (with `execute` closures bound to a request-scoped
 * `canvasId`) is built by `buildToolsForMode` in `./index.ts`.
 *
 * Building-block schemas (node / edge / command primitives) live under
 * `./schemas/`. This file only composes them into the per-tool
 * `*ParamsSchema` objects and pairs each with a description.
 */

import { Type } from '@earendil-works/pi-ai';

import { AgentCanvasCommandSchema } from './schemas/command.js';
import { OptionalCanvasIdField } from './schemas/common.js';

import type { Tool } from '@earendil-works/pi-ai';

/**
 * Definition shape we author here: a pi-ai `Tool` plus a UI-facing
 * `label`. The runnable `execute` field is added later by `buildToolsForMode`,
 * which closes over the request-scoped `canvasId`.
 */
export interface ToolDefinition extends Tool {
  /** Human-readable label, surfaced to pi-agent-core's UI hooks. */
  label: string;
}

// ==================== Web Search ====================

export const webSearchParamsSchema = Type.Object({
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
});

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  label: 'Web Search',
  description:
    'Search the internet for up-to-date facts, documentation, or news using Tavily.',
  parameters: webSearchParamsSchema,
};

// ==================== Canvas Read-Only Tools ====================

export const getNodeDetailParamsSchema = Type.Object({
  nodeId: Type.String({ description: 'The ID of the canvas node to read' }),
  ...OptionalCanvasIdField,
});

export const getNodeDetailTool: ToolDefinition = {
  name: 'get_node_detail',
  label: 'Get Node Detail',
  description:
    'Get the full content and metadata of a specific canvas node by its ID.',
  parameters: getNodeDetailParamsSchema,
};

export const getCanvasStateParamsSchema = Type.Object({
  ...OptionalCanvasIdField,
});

export const getCanvasStateTool: ToolDefinition = {
  name: 'get_canvas_state',
  label: 'Get Canvas State',
  description:
    'Get a summary of the current canvas state including all nodes, edges, and frames.',
  parameters: getCanvasStateParamsSchema,
};

// ==================== Canvas Commands ====================

export const canvasCommandsParamsSchema = Type.Object({
  ...OptionalCanvasIdField,
  commands: Type.Array(AgentCanvasCommandSchema, {
    description: 'Array of canvas commands to execute as a batch',
  }),
});

export const canvasCommandsTool: ToolDefinition = {
  name: 'canvas_commands',
  label: 'Canvas Commands',
  description: `Execute a batch of canvas commands atomically. All commands in a single call are applied as one undo step.

## Command types

- CREATE_NODES — create one or more nodes. Set skipAutoLayout: true when you provide explicit positions.
- CREATE_QUESTION — create a question node on the canvas. The agent uses this to pose follow-up questions or prompts to the user. Provide the question text as content.
- DELETE_NODES — delete nodes by ID (also removes incident edges)
- MERGE_NODE_DATA — shallow-merge a patch into node data (label, content, style). Style supports accent (hex color for top border stripe, shared palette with edge strokes) and backgroundColor on all node types; text-related style fields only apply to text nodes.
- SET_NODE_PARENT — move nodes into/out of a frame
- DISSOLVE_FRAME — ungroup a frame, keeping child nodes
- SET_NODE_GEOMETRY — set position and/or size of nodes
- REORDER_NODES — change z-order of nodes
- CONNECT_NODES — create edges between nodes (with optional style)
- DISCONNECT_EDGES — remove edges by ID or source/target pair
- SET_EDGE_STYLE — update visual style of existing edges
- ALIGN_NODES — align selected nodes along an axis
- DISTRIBUTE_NODES — evenly distribute selected nodes
- AUTO_LAYOUT — run force-directed layout on canvas or frame

## ID conventions

- Node IDs: "node-<uuid>" (use crypto.randomUUID())
- Edge IDs: "edge-<uuid>"
- When a later command in the batch needs to reference a node created by an earlier command, provide an explicit id in CREATE_NODES.

## Common patterns

Group into frame: CREATE_NODES (frame) + SET_NODE_PARENT (children → frame)
Create and connect: CREATE_NODES (multiple nodes with explicit ids) + CONNECT_NODES (edges referencing those ids)`,
  parameters: canvasCommandsParamsSchema,
};

// ==================== Content Ingestion Tools ====================

export const ingestContentParamsSchema = Type.Object({
  ...OptionalCanvasIdField,
  nodeId: Type.String({
    description: 'The node ID to trigger ingestion for',
  }),
});

export const ingestContentTool: ToolDefinition = {
  name: 'ingest_content',
  label: 'Ingest Content',
  description:
    'Trigger content ingestion for a canvas node, loading its web/PDF content into the per-canvas content store.',
  parameters: ingestContentParamsSchema,
};

// ==================== Skill Tool ====================

export const useSkillParamsSchema = Type.Object({
  skillId: Type.String({
    description:
      'The skill ID to load. See the skill catalogue in the system prompt for available IDs.',
  }),
});

export const useSkillTool: ToolDefinition = {
  name: 'use_skill',
  label: 'Use Skill',
  description:
    'Load detailed guidance for a specific skill before executing complex canvas operations. Call this when you need step-by-step guidance for tasks like building flowcharts, creating structured layouts, synthesizing nodes, etc. The skill content will be returned as the tool result.',
  parameters: useSkillParamsSchema,
};

// ==================== Tool Sets by Mode ====================

/**
 * Tools available in chat mode.
 * Includes read-only canvas/content access so the agent can
 * lazily fetch full content of selected nodes on demand.
 */
export const chatTools: ToolDefinition[] = [webSearchTool, getNodeDetailTool];

/**
 * Tools available in operate mode.
 * Full set of canvas manipulation tools for intent execution.
 */
export const operateTools: ToolDefinition[] = [
  webSearchTool,
  getCanvasStateTool,
  getNodeDetailTool,
  canvasCommandsTool,
  useSkillTool,
  ingestContentTool,
];
