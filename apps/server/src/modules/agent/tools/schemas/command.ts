/**
 * `CanvasCommand` discriminated union schema for the agent.
 *
 * Covers exactly the command names listed in
 * `AGENT_CANVAS_COMMAND_TYPES` (shared). The compile-time guard that
 * enforces "every non-UI CanvasCommand is either listed in the agent
 * set or excluded" lives next to that array in `command.ts` (shared),
 * so we don't need a duplicate guard here.
 */

import { Type } from '@earendil-works/pi-ai';

import {
  CANVAS_ALIGN_DIRECTIONS,
  FRAME_LAYOUT_MODES,
  FRAME_SIZING_MODES,
} from '@sediment/shared';

import { literalUnion, NodeSizeSchema, PointSchema } from './common.js';
import {
  EdgeCreateInputSchema,
  EdgeRefSchema,
  EdgeStylePatchSchema,
} from './edge.js';
import { NodeCreateInputSchema, NodeDataSchema } from './node.js';

export const AlignDirectionSchema = literalUnion(CANVAS_ALIGN_DIRECTIONS);

/**
 * The 13-arm discriminated union of agent-allowed canvas commands.
 * Order here mirrors the order documented in `canvasCommandsTool`'s
 * description so the LLM-facing schema and prose stay in sync.
 */
export const AgentCanvasCommandSchema = Type.Union([
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
    type: Type.Literal('CREATE_QUESTION'),
    id: Type.Optional(
      Type.String({ description: 'Explicit node ID (node-<uuid>)' }),
    ),
    content: Type.String({ description: 'The question text content' }),
    position: Type.Optional(PointSchema, {
      description:
        'Required. The top-left position of the question node. Although marked optional in the schema for compatibility, you MUST always specify explicit coordinates because the auto-layout engine has been removed.',
    }),
    size: Type.Optional(NodeSizeSchema),
    parentId: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description: 'Parent frame id, or null for root',
      }),
    ),
  }),
  Type.Object({
    type: Type.Literal('SET_FRAME_LAYOUT'),
    frameId: Type.String({ description: 'Target frame node id' }),
    mode: literalUnion(FRAME_LAYOUT_MODES, {
      description:
        '`free` keeps children where they are; `column` / `row` enable structured masonry layout (engine reflows children + resizes the frame to fit on every child change).',
    }),
    gridCount: Type.Optional(
      Type.Integer({
        description:
          "Number of tracks (columns or rows) when mode is `column`/`row`. Clamped to [1, 12]. Ignored for `free`. Omit to keep the frame's previous value (or the default of 1).",
        minimum: 1,
        maximum: 12,
      }),
    ),
    sizing: Type.Optional(
      literalUnion(FRAME_SIZING_MODES, {
        description:
          "`hug` (default) auto-fits the frame to its children; `manual` keeps the frame's user-pinned size and excludes the frame's own size from the engine's end-of-batch fit pass. For `column` / `row` frames, `manual` still re-packs children into tracks but leaves the frame size pinned (children may overflow the main axis). Omit to leave the frame's current sizing unchanged.",
      }),
    ),
  }),
]);
