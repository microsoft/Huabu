/**
 * Shared edge z-index plumbing used by both the canvas (which writes
 * `edge.zIndex`) and `LabelledEdge` (which reads it to mirror the
 * edge's render layer onto the HTML label portal).
 *
 * Centralising the formula + the selection-bump constant here keeps
 * the writer (Canvas `displayEdges`) and the reader (label portal) in
 * sync — neither side hard-codes the magic number, and if React
 * Flow's internal `edge.zIndex + max(endpoint.z)` formula ever
 * changes, there is one place to update.
 */

/**
 * Amount we add to `edge.zIndex` when an edge is visually selected so
 * the highlighted line (and its label, which mirrors `edge.zIndex`)
 * sits one layer above same-level nodes. Deliberately tiny so the
 * selection lift does not leap over higher-layer (framed) nodes.
 */
export const EDGE_SELECTED_Z_BUMP = 1;

/**
 * Replicate React Flow's internal edge render-z formula for use in
 * portal-rendered overlays (e.g. the editable label pill in
 * {@link ./LabelledEdge.LabelledEdge}). React Flow paints edge SVGs
 * at `edge.zIndex + max(endpoint.internals.z)`; the `edgelabel-renderer`
 * portal has no stacking context of its own, so any HTML rendered into
 * it must compute the same value or it will detach from its edge line
 * the moment one of the endpoints' z changes (drag, framed nesting).
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
