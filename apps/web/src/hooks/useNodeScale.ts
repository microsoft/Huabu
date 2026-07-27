import {
  getHeightRefWidth,
  MIN_CONTENT_SCALE,
} from '@sediment/shared/canvas-engine';

import useCanvasStore from '@/store/canvasStore';

/**
 * Returns a scale factor based on the node's current width relative to its
 * reference width.  Content containers can wrap their children with a CSS
 * `transform: scale(factor)` so text and layout scale proportionally when
 * the node is resized.
 *
 * The reference widths live in the shared height policy table, because the
 * headless conversion from an intrinsic content height to a node layout
 * height has to apply the identical factor.
 *
 * At the default creation size the scale is 1.  Clamped to min 0.5.
 */
export function useNodeScale(nodeId: string, nodeType: string): number {
  const refWidth = getHeightRefWidth(nodeType);

  return useCanvasStore((state) => {
    if (!refWidth) return 1;
    const node = state.nodes.find((n) => n.id === nodeId);
    const w = (node?.style?.width as number | undefined) ?? refWidth;
    return Math.max(MIN_CONTENT_SCALE, w / refWidth);
  });
}
