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
export const NodeTypeSchema = literalUnion(AGENT_CREATABLE_NODE_TYPES, {
  description:
    "The kind of node to create. `question` holds a question the **user** wants an agent to answer, anchored to its context — not a way for you to ask the user for input; create one only on the user's explicit request (e.g. a sketch '?' gesture), never proactively. The rest are plain content (note / text / web / image / pdf / office / video) or a container (frame).",
});

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
          description: `Single color token for the node. Drives border, fill tint, and text tint together — there is no separate background/text color field. Use the same token across one logical group and distinct tokens to separate groups (the grouping reads even at low zoom); reserve \`"grey"\` for de-emphasised / neutral material. Pass \`null\` to clear. Tokens map to: ${ACCENT_PALETTE.map((c) => `"${c.token}"=${c.value} (${c.name})`).join(', ')}.`,
        },
      ),
    ),
    fontFamily: Type.Optional(NodeFontFamilySchema),
    fontWeight: Type.Optional(NodeFontWeightSchema),
    fontStyle: Type.Optional(NodeFontStyleSchema),
    fontSize: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          'Font size in px for text-bearing nodes (note / text / question). For `text` / `question` nodes this is how you make rendered text larger or smaller — their height is content-driven, so never pin `size.height`.',
      }),
    ),
    textDecoration: Type.Optional(
      Type.String({
        description: 'Space-separated: "underline", "line-through", or both',
      }),
    ),
  },
  {
    description:
      'Visual style. `accent` is the single color knob and applies to every node type; font fields apply only to text-bearing nodes (note / text / question). `MERGE_NODE_DATA` deep-merges this object, so patching one field leaves the others untouched.',
  },
);

/**
 * Structured `data` payload for create / merge commands.
 *
 * Field applicability depends on `nodeType` — note/text/question use
 * `content`, web/image/pdf/office/video use `src`, frame uses only
 * `label`. The description spells this out for the LLM so it can validate
 * locally.
 */
export const NodeDataSchema = Type.Object(
  {
    label: Type.Optional(
      Type.String({
        description:
          'Display label / title. Set a concise one on every node — it is what the user sees when zoomed out.',
      }),
    ),
    content: Type.Optional(
      Type.String({
        description:
          'Markdown content (note nodes) or plain text (text/question nodes). For note bodies, write substantive, well-formatted Markdown.',
      }),
    ),
    src: Type.Optional(
      Type.String({
        description:
          "Source pointer for media nodes (`web` / `image` / `video` / `pdf` / `office`). Accepts a staged upload path (`upload/<name>`), a bare artifact key a tool handed you (`artifact-…` / `gen-…`), or an `https://…` URL — the server relocates / downloads the bytes into the artifact store and persists a bare key, so you never convert an upload into a key yourself. Two per-type notes: a `web` node keeps a live `https://…` (or `data:` HTML) URL as-is and renders it live, and its local file must be `.html`; setting an `image` node's `src` also re-derives its height from the aspect ratio.",
      }),
    ),
    style: Type.Optional(NodeStyleSchema),
  },
  {
    description:
      'Node data. Fields depend on nodeType: note → label, content, style; text/question → label, content, style; web/image/pdf/video → label, src; frame → label',
  },
);

/** Single node entry passed to `CREATE_NODES`. */
export const NodeCreateInputSchema = Type.Object({
  nodeType: NodeTypeSchema,
  data: Type.Optional(NodeDataSchema),
  position: Type.Optional(
    Type.Object(PointSchema.properties, {
      description:
        "Required. The new node's top-left (x, y) in **parent-local** coordinates: relative to `parentId`'s frame, or absolute canvas coordinates when there is no `parentId` (root). Mirror the `position` field you read from `inspect_nodes` — NOT `absolutePosition`. Marked optional only for schema compatibility — always pass explicit coordinates: there is no auto-layout, so an omitted position drops the node at a default spot away from the user's current view, where they won't find it. Placing into a `column`/`row` frame? The position is only a sort hint — the frame decides the final slot.",
    }),
  ),
  size: Type.Optional(NodeSizeSchema),
  parentId: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: 'Parent frame id, or null for root',
    }),
  ),
});
