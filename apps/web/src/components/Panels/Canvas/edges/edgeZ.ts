// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Edge-label z-index plumbing for the HTML label portal.
 *
 * Huabu runs `<ReactFlow zIndexMode="manual">`, under which React Flow
 * paints an edge SVG at `edge.zIndex` verbatim (it does NOT add the
 * endpoints' node z the way `auto` mode does). Huabu assigns each
 * `edge.zIndex` itself in `Canvas.tsx` (via the shared `edgeZIndex` helper)
 * to the max z of the edge's framed endpoints, so the edge floats above
 * the frame background its endpoints live in. The `edgelabel-renderer`
 * portal has no stacking context of its own, so its children compete with
 * node wrappers directly. A label therefore takes one layer above the edge
 * and both endpoints; the SVG edge itself remains on its normal layer.
 *
 * Note: Huabu also runs `elevateNodesOnSelect={false}` and does not
 * bump edge `zIndex` on selection, so a selected edge stays on its natural
 * layer (design-tool style). The selection highlight is delivered purely by
 * stroke/marker styling.
 */

/**
 * Resolve the editable label pill above its edge and both connected nodes.
 */
export function getEdgeLabelRenderZ(
  edgeZIndex: number | undefined,
  sourceNodeZ: number | undefined,
  targetNodeZ: number | undefined,
): number {
  return Math.max(edgeZIndex ?? 0, sourceNodeZ ?? 0, targetNodeZ ?? 0) + 1;
}
