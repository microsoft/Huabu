/**
 * `<canvas_neighbourhood>` section renderer — the anchor node's
 * surroundings.
 *
 * Wraps the structured {@link NodeNeighbourhoodContext} the envelope
 * carries for an anchored request (e.g. a question node) in the
 * `<canvas_neighbourhood>` tag, serializing it with the built-in
 * agent's `includeFile: true` so neighbours are addressable by path.
 *
 * Output shape:
 *
 *   <canvas_neighbourhood>
 *   The user's request was anchored at a node on the canvas. …
 *   <group direction="above" arrangement="horizontal row" frame="Strategy">
 *   <node id="n-d" type="note" label="Assumptions" file="nodes/assumptions.md" preview="…" />
 *   </group>
 *   <connections>
 *   <edge from="n-a" from-label="Risks" to="n-e" to-label="Open Questions" />
 *   </connections>
 *   </canvas_neighbourhood>
 *
 * Returns `undefined` when there is no anchor, or when the anchor has no
 * useful neighbours (the serialized body is empty). The external/ACP
 * backend renders the same context with `includeFile: false` in
 * `acp/preprocessor.ts` (it reads by id, where a virtual file path would
 * be a dead reference).
 */

import { serializeNodeNeighbourhood } from '../../../canvas/node-neighbourhood.js';

import type { NodeNeighbourhoodContext } from '../../../canvas/node-neighbourhood.js';

const NEIGHBOURHOOD_INTRO =
  'The user\'s request was anchored at a node on the canvas. Use this neighbourhood to disambiguate references like "this", "the one above", or implicit pronouns. Each <node> is addressable just like a selected one — pass `file` to read() for the full body.';

/**
 * Render the `<canvas_neighbourhood>` block, or `undefined` when the
 * turn carries no anchor / no useful neighbourhood.
 */
export function renderNeighbourhoodSection(
  ctx: NodeNeighbourhoodContext | undefined,
): string | undefined {
  if (!ctx) return undefined;
  const body = serializeNodeNeighbourhood(ctx, { includeFile: true });
  if (!body) return undefined;
  return [
    '<canvas_neighbourhood>',
    NEIGHBOURHOOD_INTRO,
    body,
    '</canvas_neighbourhood>',
  ].join('\n');
}
