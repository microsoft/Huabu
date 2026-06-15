import useCanvasStore from '@/store/canvasStore';

/**
 * Reference widths at which each node type renders at its "natural"
 * (unscaled) content size.  These match the default creation dimensions.
 */
const REF_WIDTHS: Record<string, number> = {
  note: 400,
  web: 400,
  pdf: 400,
  office: 400,
};

/**
 * Returns a scale factor based on the node's current width relative to its
 * reference width.  Content containers can wrap their children with a CSS
 * `transform: scale(factor)` so text and layout scale proportionally when
 * the node is resized.
 *
 * At the default creation size the scale is 1.  Clamped to min 0.5.
 */
export function useNodeScale(nodeId: string, nodeType: string): number {
  const refWidth = REF_WIDTHS[nodeType];

  return useCanvasStore((state) => {
    if (!refWidth) return 1;
    const node = state.nodes.find((n) => n.id === nodeId);
    const w = (node?.style?.width as number | undefined) ?? refWidth;
    return Math.max(0.5, w / refWidth);
  });
}
