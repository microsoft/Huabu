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

/** Visual style applied to an edge (all fields optional). */
export const EdgeStyleSchema = Type.Object({
  lineType: Type.Optional(EdgeLineTypeSchema),
  lineStyle: Type.Optional(EdgeLineStyleSchema),
  stroke: Type.Optional(PaletteColorSchema),
  strokeWidth: Type.Optional(StrokeWidthSchema),
  direction: Type.Optional(EdgeDirectionSchema),
});

/** Single edge entry passed to `CONNECT_NODES`. */
export const EdgeCreateInputSchema = Type.Object({
  id: Type.Optional(
    Type.String({ description: 'Explicit edge ID (edge-<uuid>)' }),
  ),
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
