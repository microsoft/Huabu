/**
 * Edge-related TypeBox schemas. Visual fields share `PaletteColorSchema`
 * with nodes (see `./common.ts`), but the line-type / line-style /
 * direction enums are edge-only and live here.
 */

import { Type } from '@earendil-works/pi-ai';

import {
  EDGE_DIRECTIONS,
  EDGE_LINE_STYLES,
  EDGE_LINE_TYPES,
  EDGE_STROKE_WIDTHS,
} from '@sediment/shared';

import { literalUnion, PaletteColorSchema } from './common.js';

/** Closed enum of allowed stroke widths in pixels. */
export const StrokeWidthSchema = Type.Union(
  EDGE_STROKE_WIDTHS.map((w) => Type.Literal(w)),
  {
    description: `Edge thickness in px. Allowed: ${EDGE_STROKE_WIDTHS.join(', ')}`,
  },
);

export const EdgeLineTypeSchema = literalUnion(EDGE_LINE_TYPES);
export const EdgeLineStyleSchema = literalUnion(EDGE_LINE_STYLES);
export const EdgeDirectionSchema = literalUnion(EDGE_DIRECTIONS);

/**
 * Who last set the edge `label`. Mirrors the node-level `labelSource`.
 * The agent rarely needs to set this directly — the
 * `canvas_commands` handler auto-stamps `'agent'` whenever an LLM-issued
 * `CONNECT_NODES` / `SET_EDGE_STYLE` carries a non-empty `label` — but
 * the field is exposed here so the agent can explicitly preserve a
 * pre-existing source (e.g. when only restyling color, leave
 * `labelSource` absent and the existing value is preserved).
 */
export const EdgeLabelSourceSchema = literalUnion(['auto', 'user', 'agent']);

/** Visual style applied to an edge (all fields optional). */
export const EdgeStyleSchema = Type.Object({
  lineType: Type.Optional(EdgeLineTypeSchema),
  lineStyle: Type.Optional(EdgeLineStyleSchema),
  stroke: Type.Optional(PaletteColorSchema),
  strokeWidth: Type.Optional(StrokeWidthSchema),
  direction: Type.Optional(EdgeDirectionSchema),
  label: Type.Optional(
    Type.String({
      description:
        'Short text label rendered at the edge midpoint (e.g. "leads to", "blocks"). Pass an empty string to clear an existing label. Keep it under ~24 chars so it stays legible at the default font size.',
      maxLength: 120,
    }),
  ),
  labelSource: Type.Optional(EdgeLabelSourceSchema),
});

/** Single edge entry passed to `CONNECT_NODES`. */
export const EdgeCreateInputSchema = Type.Object({
  source: Type.String({ description: 'Source node ID' }),
  target: Type.String({ description: 'Target node ID' }),
  style: Type.Optional(EdgeStyleSchema),
});

/**
 * Edge reference accepted by `DISCONNECT_EDGES` / `SET_EDGE_STYLE`.
 * Either an explicit edge id, or the source/target pair (matches
 * whichever edge connects those endpoints).
 */
export const EdgeRefSchema = Type.Union([
  Type.String({ description: 'Edge ID (edge-<uuid>)' }),
  Type.Object({
    source: Type.String(),
    target: Type.String(),
  }),
]);

/** One `(edge, style)` patch for `SET_EDGE_STYLE`. */
export const EdgeStylePatchSchema = Type.Object({
  edge: EdgeRefSchema,
  style: EdgeStyleSchema,
});
