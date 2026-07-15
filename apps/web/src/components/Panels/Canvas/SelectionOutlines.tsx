import { useStore, useViewport } from '@xyflow/react';
import { useMemo } from 'react';
import { createPortal } from 'react-dom';

import {
  getAbsolutePosition,
  getNodeSize,
  type NestableNode,
} from '@sediment/shared/canvas-engine';

import useCanvasStore from '@/store/canvasStore';

import type { CanvasNode } from '@/components/Nodes/types';

/**
 * Per-node selection outlines, rendered above all canvas content.
 *
 * Sediment runs `<ReactFlow elevateNodesOnSelect={false}>` so a node's
 * z-order does not change when it is selected (design-tool style: selection is
 * a HUD layer, not a re-stacking gesture). To keep the selection still
 * legible when the selected node sits behind another, this component
 * draws each selected node's outline as a screen-space overlay portalled
 * into the `.react-flow` container — same trick `MultiSelectResizer` uses
 * for the bounding-box outline.
 *
 * Visual contract:
 *  - 1px solid `--color-info` (sketch nodes: half-opacity, matching the
 *    softer in-node ring they used to render before this refactor).
 *  - `border-radius` scales with `zoom` so the outline tracks the node's
 *    `rounded-lg` corners at any view scale.
 *  - `pointer-events: none` — purely cosmetic; pointer hit-testing still
 *    targets the underlying node DOM (so a covered selected node remains
 *    un-clickable through the covering node, matching common design tools).
 *
 * Multi-select bounding-box + corner handles continue to come from
 * `MultiSelectResizer`; this component draws the individual node
 * outlines on top of it.
 */
export const SelectionOutlines = () => {
  const nodes = useCanvasStore((s) => s.nodes);
  const { zoom, x: vpX, y: vpY } = useViewport();
  const domNode = useStore((s) => s.domNode);

  const selectedNodes = useMemo(
    () => nodes.filter((n) => n.selected) as CanvasNode[],
    [nodes],
  );

  if (selectedNodes.length === 0 || !domNode) return null;

  // Corner radius of the node body (`rounded-lg` in NodeWrapper). Kept
  // in lockstep with the Tailwind class — if NodeWrapper ever switches
  // to a different radius, update this constant too.
  const NODE_RADIUS_PX = 8;

  const outlines = selectedNodes.map((n) => {
    const abs =
      getAbsolutePosition(nodes as NestableNode[], n.id) ?? n.position;
    const { width, height } = getNodeSize(n);
    // Fall back to xyflow's typical defaults when the node has no
    // explicit measured size yet (e.g. a freshly added node mid-frame).
    const w = (width || 200) * zoom;
    const h = (height || 100) * zoom;
    const left = abs.x * zoom + vpX;
    const top = abs.y * zoom + vpY;

    const isSketch = n.type === 'sketch';

    return (
      <div
        key={n.id}
        className="pointer-events-none absolute z-998"
        style={{
          left,
          top,
          width: w,
          height: h,
          outline: `1px solid var(--color-info)`,
          outlineOffset: 0,
          borderRadius: NODE_RADIUS_PX * zoom,
          // Soft `info-light` glow so the node selection reads the same
          // as the selected-edge treatment (info core + info-light halo,
          // see `.react-flow__edge.selected` in index.css). A larger blur
          // than the edge's 2px drop-shadow is needed because the halo
          // wraps a big rectangle rather than a hairline stroke, so a
          // tight radius would be visually diluted to nothing.
          boxShadow: `0 0 6px 0 var(--color-info-light)`,
          opacity: isSketch ? 0.5 : 1,
        }}
      />
    );
  });

  return createPortal(<>{outlines}</>, domNode);
};
