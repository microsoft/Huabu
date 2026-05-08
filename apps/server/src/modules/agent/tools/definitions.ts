/**
 * Tool Definitions for the Unified Agent
 *
 * All tools the AI can call across ask and operate modes.
 * Each tool is a pi-ai Tool with a TypeBox schema for validation.
 */

import { Type } from '@mariozechner/pi-ai';
import {
  COLOR_PALETTE,
  EDGE_STROKE_WIDTHS,
  NODE_BG_COLORS,
} from '@sediment/shared';

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
    canvasId: Type.Optional(
      Type.String({
        description:
          'Optional canvas ID override. When omitted, the current request canvas is used.',
      }),
    ),
  }),
};

export const getCanvasStateTool: Tool = {
  name: 'get_canvas_state',
  description:
    'Get a summary of the current canvas state including all nodes, edges, and frames.',
  parameters: Type.Object({
    canvasId: Type.Optional(
      Type.String({
        description:
          'Optional canvas ID override. When omitted, the current request canvas is used.',
      }),
    ),
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

// ---- Shared color / width schemas (used by both node and edge styles) ----

const PaletteColorSchema = Type.Union(
  COLOR_PALETTE.map((c) => Type.Literal(c.value)),
  {
    description: `Color hex. Allowed: ${COLOR_PALETTE.map((c) => `"${c.value}" (${c.name})`).join(', ')}`,
  },
);

const StrokeWidthSchema = Type.Union(
  EDGE_STROKE_WIDTHS.map((w) => Type.Literal(w)),
  {
    description: `Edge thickness in px. Allowed: ${EDGE_STROKE_WIDTHS.join(', ')}`,
  },
);

// ---- Node style schemas ----

const NodeBgColorSchema = Type.Union(
  NODE_BG_COLORS.map((c) => Type.Literal(c.value)),
  {
    description: `Background color (hex / keyword). Allowed: ${NODE_BG_COLORS.map((c) => `"${c.value}" (${c.name})`).join(', ')}`,
  },
);

const NodeFontFamilySchema = Type.Union([
  Type.Literal('default'),
  Type.Literal('serif'),
  Type.Literal('mono'),
  Type.Literal('hand'),
]);

const NodeFontWeightSchema = Type.Union([
  Type.Literal('normal'),
  Type.Literal('bold'),
]);

const NodeFontStyleSchema = Type.Union([
  Type.Literal('normal'),
  Type.Literal('italic'),
]);

const NodeStyleSchema = Type.Object(
  {
    backgroundColor: Type.Optional(NodeBgColorSchema),
    textColor: Type.Optional(PaletteColorSchema),
    accent: Type.Optional(
      Type.Union(
        [...COLOR_PALETTE.map((c) => Type.Literal(c.value)), Type.Null()],
        {
          description:
            'Accent color shown as a colored shadow on the bottom-right. Use a palette hex value, or null to remove. Shared palette with edge stroke colors.',
        },
      ),
    ),
    fontFamily: Type.Optional(NodeFontFamilySchema),
    fontWeight: Type.Optional(NodeFontWeightSchema),
    fontStyle: Type.Optional(NodeFontStyleSchema),
    textDecoration: Type.Optional(
      Type.String({
        description: 'Space-separated: "underline", "line-through", or both',
      }),
    ),
  },
  {
    description:
      'Visual style — full support on text nodes only. backgroundColor and accent apply to all node types.',
  },
);

// ---- Node data schema (structured per nodeType) ----

const NodeDataSchema = Type.Object(
  {
    label: Type.Optional(Type.String({ description: 'Display label / title' })),
    content: Type.Optional(
      Type.String({
        description: 'Markdown content (note nodes) or plain text (text nodes)',
      }),
    ),
    src: Type.Optional(
      Type.String({
        description: 'URL or path (web, image, pdf, video nodes)',
      }),
    ),
    style: Type.Optional(NodeStyleSchema),
  },
  {
    description:
      'Node data. Fields depend on nodeType: note → label, content, style; text → label, content, style; web/image/pdf/video → label, src; frame → label',
  },
);

const NodeCreateInputSchema = Type.Object({
  id: Type.Optional(
    Type.String({ description: 'Explicit node ID (node-<uuid>)' }),
  ),
  nodeType: NodeTypeSchema,
  data: Type.Optional(NodeDataSchema),
  position: Type.Optional(PointSchema),
  size: Type.Optional(NodeSizeSchema),
  parentId: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: 'Parent frame id, or null for root',
    }),
  ),
  skipAutoLayout: Type.Optional(
    Type.Boolean({
      description:
        'When true, skip auto-placement so the explicit position is preserved exactly.',
    }),
  ),
});

const EdgeLineTypeSchema = Type.Union([
  Type.Literal('bezier'),
  Type.Literal('straight'),
  Type.Literal('step'),
]);

const EdgeLineStyleSchema = Type.Union([
  Type.Literal('solid'),
  Type.Literal('dashed'),
  Type.Literal('dotted'),
]);

const EdgeDirectionSchema = Type.Union([
  Type.Literal('none'),
  Type.Literal('forward'),
  Type.Literal('backward'),
  Type.Literal('both'),
]);

const EdgeStyleSchema = Type.Object({
  lineType: Type.Optional(EdgeLineTypeSchema),
  lineStyle: Type.Optional(EdgeLineStyleSchema),
  stroke: Type.Optional(PaletteColorSchema),
  strokeWidth: Type.Optional(StrokeWidthSchema),
  animated: Type.Optional(
    Type.Boolean({ description: 'Animated flowing dots' }),
  ),
  direction: Type.Optional(EdgeDirectionSchema),
});

const EdgeCreateInputSchema = Type.Object({
  id: Type.Optional(
    Type.String({ description: 'Explicit edge ID (edge-<uuid>)' }),
  ),
  source: Type.String({ description: 'Source node ID' }),
  target: Type.String({ description: 'Target node ID' }),
  style: Type.Optional(EdgeStyleSchema),
});

const EdgeRefSchema = Type.Union([
  Type.String({ description: 'Edge ID (edge-<uuid>)' }),
  Type.Object({
    source: Type.String(),
    target: Type.String(),
  }),
]);

const EdgeStylePatchSchema = Type.Object({
  edge: EdgeRefSchema,
  style: EdgeStyleSchema,
});

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
 * TypeBox schema for the 13 agent-allowed CanvasCommand types.
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
        patch: NodeDataSchema,
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
    type: Type.Literal('SET_EDGE_STYLE'),
    edges: Type.Array(EdgeStylePatchSchema),
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
  Type.Object({
    type: Type.Literal('CREATE_QUESTION'),
    id: Type.Optional(
      Type.String({ description: 'Explicit node ID (node-<uuid>)' }),
    ),
    content: Type.String({ description: 'The question text content' }),
    position: Type.Optional(PointSchema),
    size: Type.Optional(NodeSizeSchema),
    parentId: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description: 'Parent frame id, or null for root',
      }),
    ),
    skipAutoLayout: Type.Optional(
      Type.Boolean({
        description:
          'When true, skip auto-placement so the explicit position is preserved exactly.',
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
  | 'SET_EDGE_STYLE'
  | 'ALIGN_NODES'
  | 'DISTRIBUTE_NODES'
  | 'AUTO_LAYOUT'
  | 'CREATE_QUESTION';
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
  parameters: Type.Object({
    canvasId: Type.Optional(
      Type.String({
        description:
          'Optional canvas ID override. When omitted, the current request canvas is used.',
      }),
    ),
    commands: Type.Array(AgentCanvasCommandSchema, {
      description: 'Array of canvas commands to execute as a batch',
    }),
  }),
};

// ==================== Content Ingestion Tools ====================

export const ingestContentTool: Tool = {
  name: 'ingest_content',
  description:
    'Trigger content ingestion for a canvas node, loading its web/PDF content into the per-canvas content store.',
  parameters: Type.Object({
    canvasId: Type.Optional(
      Type.String({
        description:
          'Optional canvas ID override. When omitted, the current request canvas is used.',
      }),
    ),
    nodeId: Type.String({
      description: 'The node ID to trigger ingestion for',
    }),
  }),
};

// ==================== Skill Tool ====================

export const useSkillTool: Tool = {
  name: 'use_skill',
  description:
    'Load detailed guidance for a specific skill before executing complex canvas operations. Call this when you need step-by-step guidance for tasks like building flowcharts, creating structured layouts, synthesizing nodes, etc. The skill content will be returned as the tool result.',
  parameters: Type.Object({
    skillId: Type.String({
      description:
        'The skill ID to load. See the skill catalogue in the system prompt for available IDs.',
    }),
  }),
};

// ==================== Tool Sets by Mode ====================

/**
 * Tools available in chat mode.
 * Includes read-only canvas/content access so the agent can
 * lazily fetch full content of selected nodes on demand.
 */
export const chatTools: Tool[] = [webSearchTool, getNodeDetailTool];

/**
 * Tools available in operate mode.
 * Full set of canvas manipulation tools for intent execution.
 */
export const operateTools: Tool[] = [
  webSearchTool,
  getCanvasStateTool,
  getNodeDetailTool,
  canvasCommandsTool,
  useSkillTool,
  ingestContentTool,
];
