/**
 * Shared edge z-index plumbing used by `LabelledEdge` to mirror the
 * edge SVG's render layer onto its HTML label portal.
 *
 * React Flow paints edge SVGs at `edge.zIndex + max(endpoint.internals.z)`;
 * the `edgelabel-renderer` portal has no stacking context of its own,
 * so any HTML rendered into it must compute the same value or it will
 * detach from its edge line the moment one of the endpoints' z changes
 * (drag, framed nesting). Centralising the formula keeps `LabelledEdge`
 * in sync with React Flow's internals — if the formula ever changes,
 * there is one place to update.
 *
 * Note: Sediment runs `<ReactFlow elevateNodesOnSelect={false}>` and
 * does not bump edge `zIndex` on selection either, so a selected edge
 * stays on its natural layer (Figma-style). The selection highlight is
 * delivered purely by stroke/marker styling.
 */

/**
 * Replicate React Flow's internal edge render-z formula for use in
 * portal-rendered overlays (e.g. the editable label pill in
 * {@link ./LabelledEdge.LabelledEdge}).
 *
 * Pass `null` / `undefined` for endpoints that have not yet been
 * resolved (e.g. during an in-flight node deletion) and they contribute
 * 0 to the max — same fallback React Flow itself uses.
 */
export function getEdgeRenderZ(
  edgeZIndex: number | undefined,
  sourceNodeZ: number | undefined,
  targetNodeZ: number | undefined,
): number {
  const base = typeof edgeZIndex === 'number' ? edgeZIndex : 0;
  const src = typeof sourceNodeZ === 'number' ? sourceNodeZ : 0;
  const tgt = typeof targetNodeZ === 'number' ? targetNodeZ : 0;
  return base + Math.max(src, tgt);
}
