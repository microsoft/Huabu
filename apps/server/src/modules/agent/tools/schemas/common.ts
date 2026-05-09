/**
 * Shared TypeBox primitives reused across node, edge, and command
 * schemas. Keep this file framework-agnostic — anything that depends
 * on a specific subdomain (node-only style fields, edge-only line
 * types, etc.) belongs in the matching `node.ts` / `edge.ts` /
 * `command.ts`.
 */

import { Type } from '@earendil-works/pi-ai';
import { ACCENT_PALETTE } from '@sediment/shared';

/**
 * Build a TypeBox literal-string union from an `as const` array. Used to
 * derive every closed enum schema from the single source of truth that
 * lives in `@sediment/shared`, so adding/removing a literal there
 * automatically propagates to the schema we expose to the LLM.
 */
export const literalUnion = <T extends readonly string[]>(
  values: T,
  options?: Parameters<typeof Type.Union>[1],
) =>
  Type.Union(
    values.map((v) => Type.Literal(v)),
    options,
  );

/** Cartesian point used by node geometry and command arguments. */
export const PointSchema = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
});

/** Node bounding box; height is optional for auto-sized nodes. */
export const NodeSizeSchema = Type.Object({
  width: Type.Number(),
  height: Type.Optional(Type.Number()),
});

/**
 * Palette colour token shared by node text/accent and edge stroke.
 *
 * Tokens (e.g. "purple") map to the current hex via
 * `@sediment/shared/ACCENT_PALETTE` at render time, so re-skinning the
 * app does not require migrating every stored canvas. The description
 * embeds the current token ↔ hex map so the LLM can pick by visual
 * appearance without us spelling out hex anywhere else.
 */
export const PaletteColorSchema = Type.Union(
  ACCENT_PALETTE.map((c) => Type.Literal(c.token)),
  {
    description: `Palette color token. Tokens map to: ${ACCENT_PALETTE.map((c) => `"${c.token}"=${c.value} (${c.name})`).join(', ')}`,
  },
);
