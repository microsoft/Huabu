/**
 * Node-related TypeBox schemas.
 *
 * Style fields are split between `node.ts` and `edge.ts` even when they
 * share a palette so each module owns one cohesive domain (node-only
 * font fields here; edge-only line type/style fields there).
 * Truly cross-cutting primitives — palette colour, point, size —
 * live in `./common.ts`.
 */

import { Type } from '@earendil-works/pi-ai';

import {
  ACCENT_PALETTE,
  AGENT_CREATABLE_NODE_TYPES,
  NODE_FONT_FAMILIES,
  NODE_FONT_STYLES,
  NODE_FONT_WEIGHTS,
} from '@sediment/shared';

import { literalUnion, NodeSizeSchema, PointSchema } from './common.js';

/** Node `type` discriminator restricted to the agent-creatable set. */
export const NodeTypeSchema = literalUnion(AGENT_CREATABLE_NODE_TYPES);

export const NodeFontFamilySchema = literalUnion(NODE_FONT_FAMILIES);
export const NodeFontWeightSchema = literalUnion(NODE_FONT_WEIGHTS);
export const NodeFontStyleSchema = literalUnion(NODE_FONT_STYLES);

/**
 * Visual style applied to a node. `accent` is the single color knob —
 * it drives the node's border, fill tint, and text tint together. Font
 * fields apply only to text-bearing nodes (note / text / question); the
 * other node types ignore them.
 */
export const NodeStyleSchema = Type.Object(
  {
    accent: Type.Optional(
      Type.Union(
        [...ACCENT_PALETTE.map((c) => Type.Literal(c.token)), Type.Null()],
        {
          description: `Single color token for the node. Drives border, fill tint, and text tint together — there is no separate background/text color field. Pass \`null\` to clear. Tokens map to: ${ACCENT_PALETTE.map((c) => `"${c.token}"=${c.value} (${c.name})`).join(', ')}.`,
        },
      ),
    ),
    fontFamily: Type.Optional(NodeFontFamilySchema),
    fontWeight: Type.Optional(NodeFontWeightSchema),
    fontStyle: Type.Optional(NodeFontStyleSchema),
    fontSize: Type.Optional(Type.Number({ minimum: 1 })),
    textDecoration: Type.Optional(
      Type.String({
        description: 'Space-separated: "underline", "line-through", or both',
      }),
    ),
  },
  {
    description:
      'Visual style. `accent` is the single color knob and applies to every node type; font fields apply only to text-bearing nodes (note / text / question).',
  },
);

/**
 * Structured `data` payload for create / merge commands.
 *
 * Field applicability depends on `nodeType` — note/text use `content`,
 * web/image/pdf/video use `src`, frame uses only `label`. The
 * description spells this out for the LLM so it can validate locally.
 */
export const NodeDataSchema = Type.Object(
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

/** Single node entry passed to `CREATE_NODES`. */
export const NodeCreateInputSchema = Type.Object({
  id: Type.Optional(
    Type.String({ description: 'Explicit node ID (node-<uuid>)' }),
  ),
  nodeType: NodeTypeSchema,
  data: Type.Optional(NodeDataSchema),
  position: Type.Optional(PointSchema, {
    description:
      'Required. The top-left position of the new node. Although marked optional in the schema for compatibility, you MUST always specify explicit coordinates because the auto-layout engine has been removed.',
  }),
  size: Type.Optional(NodeSizeSchema),
  parentId: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: 'Parent frame id, or null for root',
    }),
  ),
});
