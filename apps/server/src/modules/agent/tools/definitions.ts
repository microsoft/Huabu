/**
 * Tool Definitions for the Unified Agent
 *
 * All tools the AI can call across ask and operate modes.
 * Each tool is a pi-ai Tool with a TypeBox schema for validation.
 */

import { Type } from '@mariozechner/pi-ai';

import type { Tool } from '@mariozechner/pi-ai';
import type { AgentCanvasCommandType } from '@sediment/shared';

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

// ==================== Canvas Read-Only Tools ====================

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

// ==================== Canvas Commands ====================

/**
 * TypeBox schema helpers for the CanvasCommand discriminated union.
 */
const PointSchema = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
});

const NodeSizeSchema = Type.Object({
  width: Type.Number(),
  height: Type.Optional(Type.Number()),
});

const NodeTypeSchema = Type.Union([
  Type.Literal('note'),
  Type.Literal('text'),
  Type.Literal('web'),
  Type.Literal('image'),
  Type.Literal('pdf'),
  Type.Literal('video'),
  Type.Literal('frame'),
]);

const NodeCreateInputSchema = Type.Object({
  id: Type.Optional(
    Type.String({ description: 'Explicit node ID (node-<uuid>)' }),
  ),
  nodeType: NodeTypeSchema,
  data: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'Node data: { label?, content?, src? }. Fields depend on nodeType.',
    }),
  ),
  position: Type.Optional(PointSchema),
  size: Type.Optional(NodeSizeSchema),
  parentId: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: 'Parent frame id, or null for root',
    }),
  ),
});

const EdgeCreateInputSchema = Type.Object({
  id: Type.Optional(
    Type.String({ description: 'Explicit edge ID (edge-<uuid>)' }),
  ),
  source: Type.String({ description: 'Source node ID' }),
  target: Type.String({ description: 'Target node ID' }),
});

const EdgeRefSchema = Type.Union([
  Type.String({ description: 'Edge ID (edge-<uuid>)' }),
  Type.Object({
    source: Type.String(),
    target: Type.String(),
  }),
]);

const AlignDirectionSchema = Type.Union([
  Type.Literal('left'),
  Type.Literal('center-h'),
  Type.Literal('right'),
  Type.Literal('top'),
  Type.Literal('center-v'),
  Type.Literal('bottom'),
]);

const AutoLayoutScopeSchema = Type.Union([
  Type.Object({ type: Type.Literal('canvas') }),
  Type.Object({
    type: Type.Literal('frame'),
    frameId: Type.String(),
  }),
]);

/**
 * TypeBox schema for the 12 agent-allowed CanvasCommand types.
 */
const AgentCanvasCommandSchema = Type.Union([
  Type.Object({
    type: Type.Literal('CREATE_NODES'),
    nodes: Type.Array(NodeCreateInputSchema),
  }),
  Type.Object({
    type: Type.Literal('DELETE_NODES'),
    nodeIds: Type.Array(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('MERGE_NODE_DATA'),
    patches: Type.Array(
      Type.Object({
        nodeId: Type.String(),
        patch: Type.Record(Type.String(), Type.Unknown()),
      }),
    ),
  }),
  Type.Object({
    type: Type.Literal('SET_NODE_PARENT'),
    nodeIds: Type.Array(Type.String()),
    parentId: Type.Union([Type.String(), Type.Null()]),
  }),
  Type.Object({
    type: Type.Literal('DISSOLVE_FRAME'),
    frameId: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('SET_NODE_GEOMETRY'),
    items: Type.Array(
      Type.Object({
        nodeId: Type.String(),
        position: Type.Optional(PointSchema),
        size: Type.Optional(NodeSizeSchema),
      }),
    ),
  }),
  Type.Object({
    type: Type.Literal('REORDER_NODES'),
    nodeIds: Type.Array(Type.String()),
    to: Type.Union([
      Type.Literal('top'),
      Type.Literal('bottom'),
      Type.Object({ before: Type.String() }),
      Type.Object({ after: Type.String() }),
    ]),
  }),
  Type.Object({
    type: Type.Literal('CONNECT_NODES'),
    edges: Type.Array(EdgeCreateInputSchema),
  }),
  Type.Object({
    type: Type.Literal('DISCONNECT_EDGES'),
    edges: Type.Array(EdgeRefSchema),
  }),
  Type.Object({
    type: Type.Literal('ALIGN_NODES'),
    nodeIds: Type.Array(Type.String()),
    direction: AlignDirectionSchema,
  }),
  Type.Object({
    type: Type.Literal('DISTRIBUTE_NODES'),
    nodeIds: Type.Array(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('AUTO_LAYOUT'),
    scope: AutoLayoutScopeSchema,
    options: Type.Optional(
      Type.Object({
        animate: Type.Optional(Type.Boolean()),
      }),
    ),
  }),
]);

// ---- Compile-time sync guard ----
// Ensures AgentCanvasCommandSchema covers exactly the same command types
// as the shared AgentCanvasCommand TypeScript type. If a command type is
// added or removed in command.ts, this will produce a build error here.
type SchemaCommandType =
  | 'CREATE_NODES'
  | 'DELETE_NODES'
  | 'MERGE_NODE_DATA'
  | 'SET_NODE_PARENT'
  | 'DISSOLVE_FRAME'
  | 'SET_NODE_GEOMETRY'
  | 'REORDER_NODES'
  | 'CONNECT_NODES'
  | 'DISCONNECT_EDGES'
  | 'ALIGN_NODES'
  | 'DISTRIBUTE_NODES'
  | 'AUTO_LAYOUT';
type _AssertSchemaCoversTS = SchemaCommandType extends AgentCanvasCommandType
  ? AgentCanvasCommandType extends SchemaCommandType
    ? true
    : never
  : never;

const _schemaSync: _AssertSchemaCoversTS = true;

export const canvasCommandsTool: Tool = {
  name: 'canvas_commands',
  description: `Execute a batch of canvas commands atomically. All commands in a single call are applied as one undo step.

## Command types

- CREATE_NODES { nodes: [{ nodeType, data?: { label?, content?, src? }, position?: {x,y}, id?, parentId? }] }
- DELETE_NODES { nodeIds: string[] } — also removes incident edges
- MERGE_NODE_DATA { patches: [{ nodeId, patch: { label?, content?, ... } }] }
- SET_NODE_PARENT { nodeIds: string[], parentId: string | null } — move nodes into/out of a frame
- DISSOLVE_FRAME { frameId } — ungroup a frame, keeping child nodes
- SET_NODE_GEOMETRY { items: [{ nodeId, position?, size? }] }
- REORDER_NODES { nodeIds, to: "top" | "bottom" | { before: id } | { after: id } }
- CONNECT_NODES { edges: [{ source, target, id? }] }
- DISCONNECT_EDGES { edges: [edgeId | { source, target }] }
- ALIGN_NODES { nodeIds, direction: "left"|"center-h"|"right"|"top"|"center-v"|"bottom" }
- DISTRIBUTE_NODES { nodeIds }
- AUTO_LAYOUT { scope: { type: "canvas" } | { type: "frame", frameId } }

## ID conventions

- Node IDs: "node-<uuid>" (use crypto.randomUUID())
- Edge IDs: "edge-<uuid>"
- When a later command in the batch needs to reference a node created by an earlier command, provide an explicit id in CREATE_NODES.

## Common patterns

Group into frame: CREATE_NODES (frame) + SET_NODE_PARENT (children → frame)
Create and connect: CREATE_NODES (multiple nodes with explicit ids) + CONNECT_NODES (edges referencing those ids)`,
  parameters: Type.Object({
    canvasId: Type.String({ description: 'The canvas ID' }),
    commands: Type.Array(AgentCanvasCommandSchema, {
      description: 'Array of canvas commands to execute as a batch',
    }),
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
    'Search the knowledge base for sources matching a query (by title or content keywords). When canvasId is provided, results include nodeId/parentId if the source exists on that canvas.',
  parameters: Type.Object({
    query: Type.String({ description: 'Search query' }),
    canvasId: Type.Optional(
      Type.String({
        description: 'Current canvas ID to resolve node positions',
      }),
    ),
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
 * Tools available in operate mode.
 * Full set of canvas manipulation tools for intent execution.
 */
export const operateTools: Tool[] = [
  webSearchTool,
  getCanvasStateTool,
  getNodeDetailTool,
  canvasCommandsTool,
  readSourceTool,
  searchKnowledgeTool,
  ingestContentTool,
];
