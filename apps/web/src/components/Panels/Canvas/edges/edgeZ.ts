/**
 * Shared edge z-index plumbing used by `LabelledEdge` to mirror the
 * edge SVG's render layer onto its HTML label portal.
 *
 * Sediment runs `<ReactFlow zIndexMode="manual">`, under which React Flow
 * paints an edge SVG at `edge.zIndex` verbatim (it does NOT add the
 * endpoints' node z the way `auto` mode does). Sediment assigns each
 * `edge.zIndex` itself in `Canvas.tsx` (via the shared `edgeZIndex` helper)
 * to the max z of the edge's framed endpoints, so the edge floats above
 * the frame background its endpoints live in. The `edgelabel-renderer`
 * portal has no stacking context of its own, so any HTML rendered into it
 * must reuse the same value or it detaches from its edge line. Centralising
 * the formula keeps `LabelledEdge` in sync with React Flow's internals.
 *
 * Note: Sediment also runs `elevateNodesOnSelect={false}` and does not
 * bump edge `zIndex` on selection, so a selected edge stays on its natural
 * layer (design-tool style). The selection highlight is delivered purely by
 * stroke/marker styling.
 */

/**
 * Replicate React Flow's manual-mode edge render-z for use in
 * portal-rendered overlays (e.g. the editable label pill in
 * {@link ./LabelledEdge.LabelledEdge}).
 *
 * Under `zIndexMode="manual"` the edge SVG paints at `edge.zIndex`, so the
 * label portal must use exactly that value to share the edge's layer.
 * Pass `null` / `undefined` for an edge whose zIndex is not yet resolved
 * (e.g. during an in-flight deletion) and it contributes 0.
 */
export function getEdgeRenderZ(edgeZIndex: number | undefined): number {
  return typeof edgeZIndex === 'number' ? edgeZIndex : 0;
}
