// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canonical runtime contracts for agent-facing Space queries and commands.
 *
 * These schemas are shared by native HTTP validation, capability discovery,
 * and the built-in agent tool definitions. Keep transport envelopes in this
 * module and canvas execution behavior in the canvas engine.
 */

import { z } from 'zod';

import { canvasSearchRequestSchema } from './canvas-search.js';
import {
  ACCENT_PALETTE,
  AGENT_CANVAS_COMMAND_TYPES,
  AGENT_CREATABLE_NODE_TYPES,
  CANVAS_ALIGN_DIRECTIONS,
  CANVAS_NODE_TYPES,
  EDGE_DIRECTIONS,
  EDGE_LINE_STYLES,
  EDGE_LINE_TYPES,
  EDGE_STROKE_WIDTHS,
  FRAME_GRID_MAX_COUNT,
  FRAME_GRID_MIN_COUNT,
  FRAME_LAYOUT_MODES,
  FRAME_SIZING_MODES,
  NODE_FONT_FAMILIES,
  NODE_FONT_STYLES,
  NODE_FONT_WEIGHTS,
} from '../canvas/index.js';

export const SPACE_OPERATIONS_PROTOCOL_VERSION = 2;
export const SPACE_QUERY_DEFAULT_LIMIT = 50;
export const SPACE_QUERY_MAX_LIMIT = 200;
export const SPACE_SEARCH_DEFAULT_LIMIT = 100;
export const SPACE_SEARCH_MAX_LIMIT = 2000;
export const SPACE_EXECUTE_MAX_COMMANDS = 50;
export const SPACE_SNAPSHOT_MAX_NODES = 50;
export const SPACE_SNAPSHOT_MIN_PIXELS = 256;
export const SPACE_SNAPSHOT_MAX_PIXELS = 4096;
export const SPACE_SNAPSHOT_DEFAULT_PIXELS = 1280;

export const SPACE_QUERY_TYPES = [
  'GET_SPACE_OUTLINE',
  'INSPECT_NODES',
  'INSPECT_EDGES',
  'SEARCH',
  'SNAPSHOT_NODES',
] as const;

const pointSchema = z
  .object({
    x: z.number(),
    y: z.number(),
  })
  .strict();

const canvasIdSchema = z
  .string()
  .regex(/^canvas-.+$/, 'Expected a canonical canvas- prefixed ID');

const nodeIdSchema = z
  .string()
  .regex(/^node-.+$/, 'Expected a canonical node- prefixed ID');

const nodeSizeSchema = z
  .object({
    width: z.number().positive(),
    height: z.union([z.number().positive(), z.literal('auto')]).optional(),
  })
  .strict()
  .describe(
    'Node bounding box. Set `width`. Height: pass a number to pin it, or "auto" to make the node size itself to its content (`note` only — this is the one way to say "fit this note to its text"). `image` derives height from the image\'s aspect ratio, and `text` / `question` are always content-driven, so leave `height` unset for those.',
  );

const accentTokenSchema = z
  .enum(ACCENT_PALETTE.map(({ token }) => token))
  .describe(
    `Palette color token. Tokens map to: ${ACCENT_PALETTE.map((color) => `"${color.token}"=${color.value} (${color.name})`).join(', ')}`,
  );

const nodeStyleSchema = z
  .object({
    accent: accentTokenSchema
      .nullable()
      .optional()
      .describe(
        'Single color token for the node. Drives border, fill tint, and text tint together. Pass null to clear.',
      ),
    fontFamily: z.enum(NODE_FONT_FAMILIES).optional(),
    fontWeight: z.enum(NODE_FONT_WEIGHTS).optional(),
    fontStyle: z.enum(NODE_FONT_STYLES).optional(),
    fontSize: z
      .number()
      .positive()
      .optional()
      .describe('Font size in px for text-bearing nodes.'),
    textDecoration: z
      .string()
      .max(120)
      .optional()
      .describe('Space-separated: "underline", "line-through", or both.'),
  })
  .strict()
  .describe(
    'Visual style. `accent` applies to every node type; font fields apply only to text-bearing nodes. MERGE_NODE_DATA deep-merges this object.',
  );

const agentNodeDataSchema = z
  .object({
    label: z
      .string()
      .max(500)
      .optional()
      .describe(
        'Display label or title. Set a concise one on every node so it remains identifiable when zoomed out.',
      ),
    content: z
      .string()
      .optional()
      .describe(
        'Markdown content for note nodes or plain text for text/question nodes.',
      ),
    src: z
      .string()
      .max(4096)
      .optional()
      .describe(
        'Source pointer for media nodes: a staged upload path, an artifact key, or an HTTPS URL.',
      ),
    style: nodeStyleSchema.optional(),
  })
  .strict()
  .describe(
    'Node data. Fields depend on nodeType: note/text/question use content; web/image/pdf/office/video use src; frame uses label.',
  );

const agentNodeCreateInputSchema = z
  .object({
    nodeType: z
      .enum(AGENT_CREATABLE_NODE_TYPES)
      .describe(
        "The node kind. `question` represents a question the user wants an agent to answer; create one only on the user's explicit request.",
      ),
    data: agentNodeDataSchema.optional(),
    position: pointSchema.describe(
      "Required top-left position in the node's parent-local coordinate space.",
    ),
    size: nodeSizeSchema.optional(),
    parentId: z
      .string()
      .nullable()
      .optional()
      .describe('Parent frame ID, or null for root.'),
  })
  .strict();

const edgeStyleSchema = z
  .object({
    lineType: z.enum(EDGE_LINE_TYPES).optional(),
    lineStyle: z.enum(EDGE_LINE_STYLES).optional(),
    stroke: accentTokenSchema.optional(),
    strokeWidth: z
      .union(EDGE_STROKE_WIDTHS.map((width) => z.literal(width)))
      .describe(
        `Edge thickness in px. Allowed: ${EDGE_STROKE_WIDTHS.join(', ')}.`,
      ),
    direction: z.enum(EDGE_DIRECTIONS).optional(),
    label: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Short text rendered at the edge midpoint. Pass an empty string to clear an existing label.',
      ),
  })
  .strict()
  .partial();

const edgeCreateInputSchema = z
  .object({
    source: z.string().min(1).describe('Source node ID.'),
    target: z.string().min(1).describe('Target node ID.'),
    style: edgeStyleSchema.optional(),
  })
  .strict();

const edgeRefSchema = z.union([
  z.string().min(1),
  z
    .object({
      source: z.string().min(1),
      target: z.string().min(1),
    })
    .strict(),
]);

const edgeStylePatchSchema = z
  .object({
    edge: edgeRefSchema,
    style: edgeStyleSchema,
  })
  .strict();

export const createNodesCommandSchema = z
  .object({
    type: z.literal('CREATE_NODES'),
    nodes: z.array(agentNodeCreateInputSchema).min(1),
  })
  .strict()
  .describe('Create one or more nodes with server-assigned IDs.');

export const deleteNodesCommandSchema = z
  .object({
    type: z.literal('DELETE_NODES'),
    nodeIds: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .describe('Delete nodes by ID; incident edges are removed automatically.');

const mergeNodeDataPatchSchema = z
  .object({
    nodeId: z.string().min(1),
    patch: agentNodeDataSchema,
  })
  .strict();

export const mergeNodeDataCommandSchema = z
  .object({
    type: z.literal('MERGE_NODE_DATA'),
    patches: z
      .array(
        mergeNodeDataPatchSchema.extend({
          expectRev: z.string().min(1).optional(),
        }),
      )
      .min(1),
  })
  .strict()
  .describe(
    'Merge patches into node data. patch.content is the Markdown body only, never a downloaded node sidecar or YAML frontmatter. Use expectRev for optimistic concurrency when rewriting content or src.',
  );

export const setNodeParentCommandSchema = z
  .object({
    type: z.literal('SET_NODE_PARENT'),
    nodeIds: z.array(z.string().min(1)).min(1),
    parentId: z.string().min(1).nullable(),
  })
  .strict()
  .describe('Move nodes into a frame, or out of one with parentId null.');

export const dissolveFrameCommandSchema = z
  .object({
    type: z.literal('DISSOLVE_FRAME'),
    frameId: z.string().min(1),
  })
  .strict()
  .describe('Ungroup a frame; its children stay at root.');

export const setNodeGeometryCommandSchema = z
  .object({
    type: z.literal('SET_NODE_GEOMETRY'),
    items: z
      .array(
        z.union([
          z
            .object({
              nodeId: z.string().min(1),
              position: pointSchema,
              size: nodeSizeSchema.optional(),
            })
            .strict(),
          z
            .object({
              nodeId: z.string().min(1),
              position: pointSchema.optional(),
              size: nodeSizeSchema,
            })
            .strict(),
        ]),
      )
      .min(1),
  })
  .strict()
  .describe(
    "Set position and/or size. Position is parent-local: relative to the node's current parent frame, or absolute for a root node.",
  );

export const reorderNodesCommandSchema = z
  .object({
    type: z.literal('REORDER_NODES'),
    nodeIds: z.array(z.string().min(1)).min(1),
    to: z.union([
      z.literal('top'),
      z.literal('bottom'),
      z.object({ before: z.string().min(1) }).strict(),
      z.object({ after: z.string().min(1) }).strict(),
    ]),
  })
  .strict()
  .describe('Change z-order using top, bottom, before, or after.');

export const connectNodesCommandSchema = z
  .object({
    type: z.literal('CONNECT_NODES'),
    edges: z.array(edgeCreateInputSchema).min(1),
  })
  .strict()
  .describe(
    'Connect existing nodes with server-assigned edge IDs. Endpoints must already exist.',
  );

export const disconnectEdgesCommandSchema = z
  .object({
    type: z.literal('DISCONNECT_EDGES'),
    edges: z.array(edgeRefSchema).min(1),
  })
  .strict()
  .describe('Remove edges by ID or source/target pair.');

export const setEdgeStyleCommandSchema = z
  .object({
    type: z.literal('SET_EDGE_STYLE'),
    edges: z.array(edgeStylePatchSchema).min(1),
  })
  .strict()
  .describe('Patch visual style on existing edges.');

export const alignNodesCommandSchema = z
  .object({
    type: z.literal('ALIGN_NODES'),
    nodeIds: z.array(z.string().min(1)).min(1),
    direction: z.enum(CANVAS_ALIGN_DIRECTIONS),
  })
  .strict()
  .describe('Align nodes along an axis.');

export const distributeNodesCommandSchema = z
  .object({
    type: z.literal('DISTRIBUTE_NODES'),
    nodeIds: z.array(z.string().min(1)).min(3),
  })
  .strict()
  .describe('Evenly distribute three or more nodes.');

export const setFrameLayoutCommandSchema = z
  .object({
    type: z.literal('SET_FRAME_LAYOUT'),
    frameId: z.string().min(1).describe('Target frame node ID.'),
    mode: z
      .enum(FRAME_LAYOUT_MODES)
      .describe(
        '`free` preserves child positions. `column` / `row` pack children into N independent masonry tracks: each track stacks on its own, so a track holding fewer items pulls its next item up. `grid` counts columns like `column` but also aligns rows, so a column with no child in a given row leaves that cell blank. Choose `grid` when items in different columns must stay side by side even where one column has no counterpart.',
      ),
    gridCount: z
      .number()
      .int()
      .min(FRAME_GRID_MIN_COUNT)
      .max(FRAME_GRID_MAX_COUNT)
      .optional()
      .describe(
        'Track count: columns for `column` and `grid`, rows for `row`. Ignored for `free`.',
      ),
    gridRowCount: z
      .number()
      .int()
      .min(FRAME_GRID_MIN_COUNT)
      .max(FRAME_GRID_MAX_COUNT)
      .optional()
      .describe(
        'Minimum row bands for `grid`, ignored by other modes. A floor, not an exact count — rows fewer than the children need cannot be honoured, so this only adds blank rows. Omit unless you deliberately want empty rows reserved.',
      ),
    cells: z
      .array(
        z
          .object({
            nodeId: z.string().min(1),
            column: z.number().int().min(0).optional(),
            row: z.number().int().min(0).optional(),
          })
          .strict(),
      )
      .optional()
      .describe(
        'Where each direct child sits. A structured frame computes every child position from its cell, so `position` cannot express this — pass `cells` whenever placement matters. `column` addresses columns, `row` addresses rows, `grid` addresses both; an index for an axis the mode lacks is ignored. Children you omit keep their current cell, or are auto-assigned from their current on-screen position if they have none. Skipping a row number in one column is how you leave that cell blank in `grid`. Keep indices small and contiguous — they are positions, not labels, and a row far beyond the child count is clamped, so do not encode meaning (a year, an ID) in them.',
      ),
    sizing: z
      .enum(FRAME_SIZING_MODES)
      .optional()
      .describe(
        '`hug` auto-fits the frame to children; `manual` preserves its pinned size.',
      ),
  })
  .strict()
  .describe("Set a frame's layout mode, track count, or sizing.");

export const setPortalNodePinsCommandSchema = z
  .object({
    type: z.literal('SET_PORTAL_NODE_PINS'),
    updates: z
      .array(
        z
          .object({
            sourceCanvasId: canvasIdSchema,
            sourceNodeIds: z.array(nodeIdSchema).min(1),
            pinned: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .describe(
    'Add or remove symbolic references to source Space nodes inside a Project Portal. This never modifies or deletes the source nodes.',
  );

export const AGENT_COMMAND_SCHEMAS = {
  CREATE_NODES: createNodesCommandSchema,
  DELETE_NODES: deleteNodesCommandSchema,
  MERGE_NODE_DATA: mergeNodeDataCommandSchema,
  SET_NODE_PARENT: setNodeParentCommandSchema,
  DISSOLVE_FRAME: dissolveFrameCommandSchema,
  SET_NODE_GEOMETRY: setNodeGeometryCommandSchema,
  REORDER_NODES: reorderNodesCommandSchema,
  CONNECT_NODES: connectNodesCommandSchema,
  DISCONNECT_EDGES: disconnectEdgesCommandSchema,
  SET_EDGE_STYLE: setEdgeStyleCommandSchema,
  ALIGN_NODES: alignNodesCommandSchema,
  DISTRIBUTE_NODES: distributeNodesCommandSchema,
  SET_FRAME_LAYOUT: setFrameLayoutCommandSchema,
  SET_PORTAL_NODE_PINS: setPortalNodePinsCommandSchema,
} as const satisfies Record<
  (typeof AGENT_CANVAS_COMMAND_TYPES)[number],
  z.ZodType
>;

export const agentCanvasCommandSchema = z.discriminatedUnion('type', [
  createNodesCommandSchema,
  deleteNodesCommandSchema,
  mergeNodeDataCommandSchema,
  setNodeParentCommandSchema,
  dissolveFrameCommandSchema,
  setNodeGeometryCommandSchema,
  reorderNodesCommandSchema,
  connectNodesCommandSchema,
  disconnectEdgesCommandSchema,
  setEdgeStyleCommandSchema,
  alignNodesCommandSchema,
  distributeNodesCommandSchema,
  setFrameLayoutCommandSchema,
  setPortalNodePinsCommandSchema,
]);

export type AgentOperationCommand = z.infer<typeof agentCanvasCommandSchema>;

export const builtInMergeNodeDataCommandSchema = z
  .object({
    type: z.literal('MERGE_NODE_DATA'),
    patches: z.array(mergeNodeDataPatchSchema).min(1),
  })
  .strict()
  .describe(
    'Merge patches into node data. Content revisions are injected from the built-in turn read-set.',
  );

export const builtInAgentCanvasCommandSchema = z.discriminatedUnion('type', [
  createNodesCommandSchema,
  deleteNodesCommandSchema,
  builtInMergeNodeDataCommandSchema,
  setNodeParentCommandSchema,
  dissolveFrameCommandSchema,
  setNodeGeometryCommandSchema,
  reorderNodesCommandSchema,
  connectNodesCommandSchema,
  disconnectEdgesCommandSchema,
  setEdgeStyleCommandSchema,
  alignNodesCommandSchema,
  distributeNodesCommandSchema,
  setFrameLayoutCommandSchema,
  setPortalNodePinsCommandSchema,
]);

export type BuiltInAgentOperationCommand = z.infer<
  typeof builtInAgentCanvasCommandSchema
>;

export const builtInAgentCanvasCommandsParamsSchema = z
  .object({
    commands: z
      .array(builtInAgentCanvasCommandSchema)
      .min(1)
      .describe('Space commands to execute as a batch.'),
  })
  .strict();

export type BuiltInAgentCanvasCommandsParams = z.infer<
  typeof builtInAgentCanvasCommandsParamsSchema
>;

const queryLimitSchema = z
  .number()
  .int()
  .positive()
  .max(SPACE_QUERY_MAX_LIMIT)
  .optional();

export const getSpaceOutlineQueryParamsSchema = z
  .object({
    includePreviews: z
      .boolean()
      .optional()
      .describe(
        'Attach authored summaries and short body previews. Default: false.',
      ),
    includeStyle: z
      .boolean()
      .optional()
      .describe('Attach each node visual style. Default: false.'),
  })
  .strict();
export type GetSpaceOutlineQueryParams = z.infer<
  typeof getSpaceOutlineQueryParamsSchema
>;

export const inspectNodesQueryParamsSchema = z
  .object({
    ids: z
      .array(z.string().min(1))
      .optional()
      .describe('Match these node IDs. Combinable with other filters.'),
    byType: z
      .union([
        z.enum(CANVAS_NODE_TYPES),
        z.array(z.enum(CANVAS_NODE_TYPES)).min(1),
      ])
      .optional()
      .describe('Filter by one or more node types.'),
    byParent: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Filter by parent frame ID. Pass null to match top-level nodes.',
      ),
    labelPattern: z
      .string()
      .max(200)
      .optional()
      .describe('Regular expression matched against the node label.'),
    inRect: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number().nonnegative(),
        height: z.number().nonnegative(),
      })
      .strict()
      .optional()
      .describe(
        'Match nodes whose center lies inside this absolute-coordinate rectangle.',
      ),
    nearNode: z
      .object({
        id: z.string().min(1),
        maxDistance: z.number().nonnegative().optional(),
        maxCount: z
          .number()
          .int()
          .positive()
          .max(SPACE_QUERY_MAX_LIMIT)
          .optional(),
        sameParent: z.boolean().optional(),
      })
      .strict()
      .optional()
      .describe(
        "Find nodes near the given node by edge-to-edge distance. sameParent restricts matches to the target's siblings.",
      ),
    nearPoint: z
      .object({
        x: z.number(),
        y: z.number(),
        maxDistance: z.number().nonnegative().optional(),
        maxCount: z
          .number()
          .int()
          .positive()
          .max(SPACE_QUERY_MAX_LIMIT)
          .optional(),
      })
      .strict()
      .optional()
      .describe('Find nodes near an absolute-coordinate point.'),
    inSameClusterAs: z
      .string()
      .min(1)
      .optional()
      .describe('Return other nodes in the same spatial cluster as this node.'),
    connectedTo: z
      .object({
        id: z.string().min(1),
        depth: z
          .union([z.literal(1), z.literal(2)])
          .optional()
          .describe('Hop depth, 1 or 2. Default: 1.'),
      })
      .strict()
      .optional()
      .describe(
        'Find nodes connected to the given node. The target itself is excluded.',
      ),
    sort: z
      .enum(['distance', 'reading-order', 'area'])
      .optional()
      .describe(
        'Result ordering. Defaults to distance for proximity queries, otherwise insertion order.',
      ),
    limit: queryLimitSchema.describe(
      `Maximum nodes to return. Default: ${SPACE_QUERY_DEFAULT_LIMIT}; maximum: ${SPACE_QUERY_MAX_LIMIT}.`,
    ),
  })
  .strict();
export type InspectNodesQueryParams = z.infer<
  typeof inspectNodesQueryParamsSchema
>;

export const inspectEdgesQueryParamsSchema = z
  .object({
    ids: z
      .array(z.string().min(1))
      .optional()
      .describe('Match these edge IDs.'),
    connectedTo: z
      .string()
      .min(1)
      .optional()
      .describe('Match all edges incident to this node.'),
    bySource: z
      .string()
      .min(1)
      .optional()
      .describe('Match edges originating from this node.'),
    byTarget: z
      .string()
      .min(1)
      .optional()
      .describe('Match edges terminating at this node.'),
    between: z
      .object({
        a: z.string().min(1),
        b: z.string().min(1),
      })
      .strict()
      .optional()
      .describe('Match edges connecting these nodes in either direction.'),
    byDirection: z
      .union([z.enum(EDGE_DIRECTIONS), z.array(z.enum(EDGE_DIRECTIONS)).min(1)])
      .optional()
      .describe(
        "Filter by arrow direction. Unset values are treated as 'none'.",
      ),
    byLineStyle: z
      .union([
        z.enum(EDGE_LINE_STYLES),
        z.array(z.enum(EDGE_LINE_STYLES)).min(1),
      ])
      .optional()
      .describe("Filter by dash pattern. Unset values are treated as 'solid'."),
    byLineType: z
      .union([z.enum(EDGE_LINE_TYPES), z.array(z.enum(EDGE_LINE_TYPES)).min(1)])
      .optional()
      .describe("Filter by line shape. Unset values are treated as 'bezier'."),
    byLabel: z
      .string()
      .max(200)
      .optional()
      .describe('Case-insensitive substring match on the edge label.'),
    limit: queryLimitSchema.describe(
      `Maximum edges to return. Default: ${SPACE_QUERY_DEFAULT_LIMIT}; maximum: ${SPACE_QUERY_MAX_LIMIT}.`,
    ),
  })
  .strict();
export type InspectEdgesQueryParams = z.infer<
  typeof inspectEdgesQueryParamsSchema
>;

export const searchSpaceQueryParamsSchema = canvasSearchRequestSchema
  .extend({
    limit: z.number().int().positive().max(SPACE_SEARCH_MAX_LIMIT).optional(),
  })
  .strict();

export const snapshotNodesQueryParamsSchema = z
  .object({
    nodeIds: z
      .array(z.string().min(1))
      .min(1)
      .max(SPACE_SNAPSHOT_MAX_NODES)
      .describe(
        'IDs of image, sketch, or frame nodes. Passing one frame ID is sufficient: frame expansion is recursive by definition and includes every nested image and sketch descendant, so callers do not need to enumerate child IDs. Multiple nearby nodes under the same parent may be spatially clustered into one composite PNG.',
      ),
    maxPixels: z
      .number()
      .int()
      .min(SPACE_SNAPSHOT_MIN_PIXELS)
      .max(SPACE_SNAPSHOT_MAX_PIXELS)
      .optional()
      .describe(
        `Longest-edge pixel cap for each PNG (${SPACE_SNAPSHOT_MIN_PIXELS}-${SPACE_SNAPSHOT_MAX_PIXELS}). Defaults to ${SPACE_SNAPSHOT_DEFAULT_PIXELS}. Reduce it when a downstream vision model rejects an oversized image. Rendered clusters are rerendered at this cap; singleton images are downscaled only when their longest edge exceeds it. Results are content-addressed by source and cap.`,
      ),
    strokeSubsets: z
      .array(
        z
          .object({
            nodeId: z.string().min(1),
            strokeIds: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .max(SPACE_SNAPSHOT_MAX_NODES)
      .optional()
      .describe(
        "Optional per-sketch KEEP lists for rendering only the named stroke IDs. Nodes without an entry render in full. If none of an entry's stroke IDs still exist, the query reports a stale-selection error instead of silently widening to the whole sketch.",
      ),
  })
  .strict();

export type SnapshotNodesQueryParams = z.infer<
  typeof snapshotNodesQueryParamsSchema
>;

export const getSpaceOutlineQuerySchema =
  getSpaceOutlineQueryParamsSchema.extend({
    type: z.literal('GET_SPACE_OUTLINE'),
  });

export const inspectNodesQuerySchema = inspectNodesQueryParamsSchema.extend({
  type: z.literal('INSPECT_NODES'),
});

export const inspectEdgesQuerySchema = inspectEdgesQueryParamsSchema.extend({
  type: z.literal('INSPECT_EDGES'),
});

export const searchSpaceQuerySchema = searchSpaceQueryParamsSchema.extend({
  type: z.literal('SEARCH'),
});

export const snapshotNodesQuerySchema = snapshotNodesQueryParamsSchema.extend({
  type: z.literal('SNAPSHOT_NODES'),
});

export const SPACE_QUERY_SCHEMAS = {
  GET_SPACE_OUTLINE: getSpaceOutlineQuerySchema,
  INSPECT_NODES: inspectNodesQuerySchema,
  INSPECT_EDGES: inspectEdgesQuerySchema,
  SEARCH: searchSpaceQuerySchema,
  SNAPSHOT_NODES: snapshotNodesQuerySchema,
} as const satisfies Record<(typeof SPACE_QUERY_TYPES)[number], z.ZodType>;

export const spaceQuerySchema = z.discriminatedUnion('type', [
  getSpaceOutlineQuerySchema,
  inspectNodesQuerySchema,
  inspectEdgesQuerySchema,
  searchSpaceQuerySchema,
  snapshotNodesQuerySchema,
]);

export type SpaceQuery = z.infer<typeof spaceQuerySchema>;

const spaceNodeResultSchema = z
  .object({
    id: z.string(),
    type: z.enum(CANVAS_NODE_TYPES),
    label: z.string().optional(),
    filename: z.string(),
    summary: z.string().optional(),
    preview: z.string().optional(),
    rev: z.string().optional(),
    parentFrame: z
      .object({
        id: z.string(),
        label: z.string().optional(),
      })
      .strict()
      .optional(),
    position: pointSchema,
    absolutePosition: pointSchema,
    size: z
      .object({
        width: z.number(),
        height: z.number(),
      })
      .strict(),
    style: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const outlineResultSchema = z
  .object({
    version: z.number(),
    bbox: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .strict()
      .nullable(),
    nodes: z.array(spaceNodeResultSchema),
    edges: z.array(
      z
        .object({
          id: z.string().optional(),
          source: z.string(),
          target: z.string(),
        })
        .strict(),
    ),
    spatial: z
      .object({
        clusters: z.array(
          z
            .object({
              frameId: z.string().optional(),
              frameLabel: z.string().optional(),
              nodeIds: z.array(z.string()),
              arrangement: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

const inspectNodesResultSchema = z
  .object({
    count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    arrangement: z.string().optional(),
    nodes: z.array(
      spaceNodeResultSchema.extend({
        distance: z.number().optional(),
        centerDistance: z.number().optional(),
        direction: z.enum(['left', 'right', 'above', 'below']).optional(),
        edgeIds: z.array(z.string()).optional(),
        hops: z.union([z.literal(1), z.literal(2)]).optional(),
        clusterId: z.string().optional(),
      }),
    ),
  })
  .strict();

const inspectEdgesResultSchema = z
  .object({
    count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    edges: z.array(
      z
        .object({
          id: z.string().optional(),
          source: z.string(),
          target: z.string(),
          lineType: z.enum(EDGE_LINE_TYPES).optional(),
          lineStyle: z.enum(EDGE_LINE_STYLES).optional(),
          stroke: z.string().optional(),
          strokeWidth: z.number().optional(),
          direction: z.enum(EDGE_DIRECTIONS).optional(),
          label: z.string().optional(),
          labelSource: z.enum(['auto', 'user', 'agent']).optional(),
        })
        .strict(),
    ),
  })
  .strict();

const searchMatchSchema = z
  .object({
    kind: z.enum(['node', 'edge']).optional(),
    nodeId: z.string(),
    nodeType: z.string(),
    label: z.string().nullable(),
    field: z.enum(['label', 'summary', 'keywords', 'content', 'conversation']),
    snippet: z.string(),
    matchStart: z.number().int().nonnegative(),
    matchLength: z.number().int().nonnegative(),
    occurrenceIndex: z.number().int().nonnegative(),
    sourceNodeId: z.string().optional(),
    targetNodeId: z.string().optional(),
  })
  .strict();

const searchResultSchema = z
  .object({
    count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    matches: z.array(
      z
        .object({
          tier: z.enum(['meta', 'content', 'conversation']),
          match: searchMatchSchema,
        })
        .strict(),
    ),
  })
  .strict();

const snapshotNodeResultSchema = z
  .object({
    src: z
      .string()
      .min(1)
      .describe(
        'Bare artifact key accepted by media-node data.src and other Huabu artifact consumers.',
      ),
    downloadPath: z
      .string()
      .min(1)
      .describe(
        'Canvas-relative path to pass to GET download/<path> for the PNG bytes.',
      ),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    originNodeIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

const snapshotNodesResultSchema = z
  .object({
    snapshots: z.array(snapshotNodeResultSchema),
  })
  .strict();

export const spaceQueryResponseSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('GET_SPACE_OUTLINE'),
      result: outlineResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('INSPECT_NODES'),
      result: inspectNodesResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('INSPECT_EDGES'),
      result: inspectEdgesResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('SEARCH'),
      result: searchResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('SNAPSHOT_NODES'),
      result: snapshotNodesResultSchema,
    })
    .strict(),
]);

export type SpaceQueryResponse = z.infer<typeof spaceQueryResponseSchema>;

const jsonSchemaSchema = z.record(z.string(), z.unknown());

export const rfsCapabilitiesResponseSchema = z
  .object({
    protocolVersion: z.literal(SPACE_OPERATIONS_PROTOCOL_VERSION),
    permissions: z
      .object({
        read: z.boolean(),
        write: z.boolean(),
      })
      .strict(),
    execution: z
      .object({
        atomic: z.literal(false),
        partialCommit: z.literal(true),
        idempotent: z.literal(false),
        runIdIsIdempotencyKey: z.literal(false),
      })
      .strict(),
    limits: z
      .object({
        queryDefault: z.literal(SPACE_QUERY_DEFAULT_LIMIT),
        queryMax: z.literal(SPACE_QUERY_MAX_LIMIT),
        searchDefault: z.literal(SPACE_SEARCH_DEFAULT_LIMIT),
        searchMax: z.literal(SPACE_SEARCH_MAX_LIMIT),
        executeMaxCommands: z.literal(SPACE_EXECUTE_MAX_COMMANDS),
        snapshotMaxNodes: z.literal(SPACE_SNAPSHOT_MAX_NODES),
      })
      .strict(),
    queryTypes: z.array(z.enum(SPACE_QUERY_TYPES)),
    commandTypes: z.array(z.enum(AGENT_CANVAS_COMMAND_TYPES)),
    links: z
      .object({
        skill: z.string(),
        query: z.string(),
        execute: z.string(),
        queryCapabilityTemplate: z.string(),
        commandCapabilityTemplate: z.string(),
      })
      .strict(),
  })
  .strict();

export type RfsCapabilitiesResponse = z.infer<
  typeof rfsCapabilitiesResponseSchema
>;

export const rfsOperationCapabilityResponseSchema = z
  .object({
    kind: z.enum(['query', 'command']),
    type: z.string(),
    schema: jsonSchemaSchema,
    constraints: z.array(z.string()),
    result: z.string(),
    examples: z.array(z.unknown()),
  })
  .strict();

export type RfsOperationCapabilityResponse = z.infer<
  typeof rfsOperationCapabilityResponseSchema
>;

export const rfsExecuteRequestSchema = z
  .object({
    runId: z.string().min(1).max(256).optional(),
    commands: z
      .array(agentCanvasCommandSchema)
      .min(1)
      .max(SPACE_EXECUTE_MAX_COMMANDS),
  })
  .strict();

export type RfsExecuteRequest = z.infer<typeof rfsExecuteRequestSchema>;

const executeResultNodeSchema = z
  .object({
    nodeId: z.string(),
    label: z.string().optional(),
    width: z.number(),
    height: z.number(),
    src: z.string().optional(),
  })
  .strict();

const executeResultEdgeSchema = z
  .object({
    edgeId: z.string(),
    source: z.string(),
    target: z.string(),
  })
  .strict();

export const rfsExecuteResponseSchema = z
  .object({
    canvasId: z.string(),
    runId: z.string(),
    fromVersion: z.number().int().nonnegative(),
    toVersion: z.number().int().nonnegative(),
    commands: z.array(agentCanvasCommandSchema),
    results: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          type: z.enum(AGENT_CANVAS_COMMAND_TYPES),
          applied: z.boolean(),
          reason: z
            .enum([
              'no-op',
              'not-found',
              'invalid-parent',
              'invalid-target',
              'invalid-scope',
              'cycle',
              'duplicate-id',
              'conflict',
            ])
            .optional(),
          nodes: z.array(executeResultNodeSchema).optional(),
          edges: z.array(executeResultEdgeSchema).optional(),
        })
        .strict(),
    ),
    revisions: z.array(
      z
        .object({
          nodeId: z.string(),
          rev: z.string(),
        })
        .strict(),
    ),
    affected: z
      .object({
        nodeIds: z.array(z.string()),
        edgeIds: z.array(z.string()),
        deletedNodeIds: z.array(z.string()),
        deletedEdgeIds: z.array(z.string()),
      })
      .strict(),
    conflicts: z
      .array(
        z
          .object({
            nodeId: z.string(),
            reason: z.enum(['not-read', 'stale']),
            expectedRev: z.string().optional(),
            currentRev: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type RfsExecuteResponse = z.infer<typeof rfsExecuteResponseSchema>;
