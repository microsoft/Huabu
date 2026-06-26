import type { ReactFlowInstance } from '@xyflow/react';

/**
 * Re-center the canvas viewport on a set of node ids.
 *
 * The Canvas runs with `onlyRenderVisibleElements`, so a target node that
 * is currently outside the viewport has never been measured by React
 * Flow. That breaks the obvious `rfInstance.fitView({ nodes })` call:
 * `fitView` derives its bounds from `node.measured.width|height`
 * (with fallbacks to `width` / `initialWidth`) and silently produces an
 * empty rect when none of those are set — leaving the viewport where it
 * was. That is the "click a row → canvas doesn't move" bug.
 *
 * This helper sidesteps the issue by computing the bounding rect from
 * `getInternalNode` (which always returns `internals.positionAbsolute`,
 * even for un-rendered nodes) and falling back to `style.width|height`
 * for the dimensions of nodes that haven't been mounted yet. We then
 * call `setCenter` directly. Zoom is capped at the current zoom (so we
 * never zoom IN past what the user has set) and at 1 (matching the
 * previous `maxZoom: 1` from the `fitView` callers).
 */
export const focusNodesOnCanvas = (
  rfInstance: ReactFlowInstance,
  nodeIds: string[],
  duration = 800,
): void => {
  if (nodeIds.length === 0) return;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const nid of nodeIds) {
    const internal = rfInstance.getInternalNode(nid);
    if (!internal || internal.hidden) continue;
    const w =
      internal.measured.width ??
      internal.width ??
      internal.initialWidth ??
      (typeof internal.style?.width === 'number' ? internal.style.width : 0);
    const h =
      internal.measured.height ??
      internal.height ??
      internal.initialHeight ??
      (typeof internal.style?.height === 'number' ? internal.style.height : 0);
    const ax = internal.internals.positionAbsolute.x;
    const ay = internal.internals.positionAbsolute.y;
    if (ax < minX) minX = ax;
    if (ay < minY) minY = ay;
    if (ax + w > maxX) maxX = ax + w;
    if (ay + h > maxY) maxY = ay + h;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const zoom = Math.min(rfInstance.getZoom(), 1);
  void rfInstance.setCenter(cx, cy, { duration, zoom });
};
