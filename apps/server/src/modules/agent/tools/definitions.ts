/**
 * Tool Definitions for the Unified Agent
 *
 * All tools the AI can call across ask and operate modes.
 * Each tool is a pi-ai Tool with a TypeBox schema for validation.
 *
 * Definitions here are pure schema + description pairs. The runnable
 * `AgentTool` form (with `execute` closures bound to a request-scoped
 * `canvasId`) is built by `buildToolsForMode` in `./index.ts`.
 */

import { Type } from '@earendil-works/pi-ai';
import {
  ACCENT_PALETTE,
  AGENT_CREATABLE_NODE_TYPES,
  CANVAS_ALIGN_DIRECTIONS,
  EDGE_DIRECTIONS,
  EDGE_LINE_STYLES,
  EDGE_LINE_TYPES,
  EDGE_STROKE_WIDTHS,
  NODE_FONT_FAMILIES,
  NODE_FONT_STYLES,
  NODE_FONT_WEIGHTS,
  SURFACE_PALETTE,
} from '@sediment/shared';

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

/**
 * Build a TypeBox literal-string union from an `as const` array. Used to
 * derive every closed enum schema from the single source of truth that
 * lives in `@sediment/shared`, so adding/removing a literal there
 * automatically propagates to the schema we expose to the LLM.
 */
const literalUnion = <T extends readonly string[]>(
  values: T,
  options?: Parameters<typeof Type.Union>[1],
) =>
  Type.Union(
    values.map((v) => Type.Literal(v)),
    options,
  );

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
  canvasId: Type.Optional(
    Type.String({
      description:
        'Optional canvas ID override. When omitted, the current request canvas is used.',
    }),
  ),
});

export const getNodeDetailTool: ToolDefinition = {
  name: 'get_node_detail',
  label: 'Get Node Detail',
  description:
    'Get the full content and metadata of a specific canvas node by its ID.',
  parameters: getNodeDetailParamsSchema,
};

export const getCanvasStateParamsSchema = Type.Object({
  canvasId: Type.Optional(
    Type.String({
      description:
        'Optional canvas ID override. When omitted, the current request canvas is used.',
    }),
  ),
});

export const getCanvasStateTool: ToolDefinition = {
  name: 'get_canvas_state',
  label: 'Get Canvas State',
  description:
    'Get a summary of the current canvas state including all nodes, edges, and frames.',
  parameters: getCanvasStateParamsSchema,
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

const NodeTypeSchema = literalUnion(AGENT_CREATABLE_NODE_TYPES);

// ---- Shared color / width schemas (used by both node and edge styles) ----

// Palette colors are referenced by stable tokens (e.g. "purple"), not raw
// hex values. Tokens map to a current hex via @sediment/shared/ACCENT_PALETTE
// at render time, so re-skinning the app does not require migrating every
// stored canvas. The description embeds the current token ↔ hex map so the
// LLM can pick by visual appearance without us spelling out hex anywhere else.
const PaletteColorSchema = Type.Union(
  ACCENT_PALETTE.map((c) => Type.Literal(c.token)),
  {
    description: `Palette color token. Tokens map to: ${ACCENT_PALETTE.map((c) => `"${c.token}"=${c.value} (${c.name})`).join(', ')}`,
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
  SURFACE_PALETTE.map((c) => Type.Literal(c.token)),
  {
    description: `Node background color token. Tokens map to: ${SURFACE_PALETTE.map((c) => `"${c.token}"=${c.value} (${c.name})`).join(', ')}`,
  },
);

const NodeFontFamilySchema = literalUnion(NODE_FONT_FAMILIES);

const NodeFontWeightSchema = literalUnion(NODE_FONT_WEIGHTS);

const NodeFontStyleSchema = literalUnion(NODE_FONT_STYLES);

const NodeStyleSchema = Type.Object(
  {
    backgroundColor: Type.Optional(NodeBgColorSchema),
    textColor: Type.Optional(PaletteColorSchema),
    accent: Type.Optional(
      Type.Union(
        [...ACCENT_PALETTE.map((c) => Type.Literal(c.token)), Type.Null()],
        {
          description:
            'Accent color token shown as a colored shadow on the bottom-right. Use a palette token (e.g. "purple") or null to remove. Shared palette with edge stroke and text color.',
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

const EdgeLineTypeSchema = literalUnion(EDGE_LINE_TYPES);

const EdgeLineStyleSchema = literalUnion(EDGE_LINE_STYLES);

const EdgeDirectionSchema = literalUnion(EDGE_DIRECTIONS);

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

const AlignDirectionSchema = literalUnion(CANVAS_ALIGN_DIRECTIONS);

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

// `AgentCanvasCommandSchema` covers the same set of command names listed in
// `AGENT_CANVAS_COMMAND_TYPES` (shared). The compile-time guard that
// enforces "every non-UI CanvasCommand is either listed in the agent set
// or excluded" lives next to that array in `command.ts`, so we don't need
// a duplicate guard here.

export const canvasCommandsParamsSchema = Type.Object({
  canvasId: Type.Optional(
    Type.String({
      description:
        'Optional canvas ID override. When omitted, the current request canvas is used.',
    }),
  ),
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
  canvasId: Type.Optional(
    Type.String({
      description:
        'Optional canvas ID override. When omitted, the current request canvas is used.',
    }),
  ),
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
