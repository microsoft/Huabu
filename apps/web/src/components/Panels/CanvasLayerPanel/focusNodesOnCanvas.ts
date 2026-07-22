import type { ReactFlowInstance } from '@xyflow/react';

type NodeBounds = { x: number; y: number; width: number; height: number };

/** Resolve bounds even when `onlyRenderVisibleElements` left nodes unmeasured. */
export const getReliableNodeBounds = (
  rfInstance: ReactFlowInstance,
  nodeIds: string[],
): NodeBounds | null => {
  if (nodeIds.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const nodeId of nodeIds) {
    const internal = rfInstance.getInternalNode(nodeId);
    if (!internal || internal.hidden) continue;
    const width =
      internal.measured.width ??
      internal.width ??
      internal.initialWidth ??
      (typeof internal.style?.width === 'number' ? internal.style.width : 0);
    const height =
      internal.measured.height ??
      internal.height ??
      internal.initialHeight ??
      (typeof internal.style?.height === 'number' ? internal.style.height : 0);
    const x = internal.internals.positionAbsolute.x;
    const y = internal.internals.positionAbsolute.y;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + width > maxX) maxX = x + width;
    if (y + height > maxY) maxY = y + height;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
};

/** Fit a set of nodes using reliable bounds rather than React Flow measurements. */
export const fitNodesOnCanvas = (
  rfInstance: ReactFlowInstance,
  nodeIds: string[],
  padding = 0.15,
): Promise<boolean> => {
  const bounds = getReliableNodeBounds(rfInstance, nodeIds);
  if (!bounds) return Promise.resolve(false);
  return rfInstance.fitBounds(bounds, { padding });
};

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
  const bounds = getReliableNodeBounds(rfInstance, nodeIds);
  if (!bounds) return;

  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const zoom = Math.min(rfInstance.getZoom(), 1);
  void rfInstance.setCenter(cx, cy, { duration, zoom });
};
