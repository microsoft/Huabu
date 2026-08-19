// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStore, useViewport } from '@xyflow/react';
import { useMemo } from 'react';
import { createPortal } from 'react-dom';

import {
  getAbsolutePosition,
  getNodeSize,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';
import {
  blendedMarkRect,
  easeToward,
  useNodeCollapseStore,
} from '@/store/nodeCollapseStore';

import { applyNodeGeometryPreviews } from './applyNodeGeometryPreview';

import type { CanvasNode } from '@/components/Nodes/types';

export function selectOutlinedNodes(
  nodes: readonly CanvasNode[],
): CanvasNode[] {
  return nodes.filter((node) => node.selected || node.dragging);
}

/**
 * Per-node selection outlines, rendered above all canvas content.
 *
 * Huabu runs `<ReactFlow elevateNodesOnSelect={false}>` so a node's
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
  const nodeGeometryPreviews = useGesturePreviewStore(
    (state) => state.nodeGeometryPreviews,
  );
  const { zoom, x: vpX, y: vpY } = useViewport();
  const domNode = useStore((s) => s.domNode);
  // Collapsed nodes have faded their card away, so outlining the footprint
  // would box a stretch of empty canvas beside the mark that replaced it.
  const marks = useNodeCollapseStore((s) => s.marks);

  const previewNodes = useMemo(
    () =>
      applyNodeGeometryPreviews(nodes as CanvasNode[], nodeGeometryPreviews),
    [nodeGeometryPreviews, nodes],
  );
  const outlinedNodes = useMemo(
    () => selectOutlinedNodes(previewNodes),
    [previewNodes],
  );

  if (outlinedNodes.length === 0 || !domNode) return null;

  // Corner radius of the node body (`rounded-lg` in NodeWrapper). Kept
  // in lockstep with the Tailwind class — if NodeWrapper ever switches
  // to a different radius, update this constant too.
  const NODE_RADIUS_PX = 8;

  const outlines = outlinedNodes.map((n) => {
    const mark = marks[n.id];
    const abs =
      getAbsolutePosition(previewNodes as NestableNode[], n.id) ?? n.position;
    const { width, height } = getNodeSize(n);
    // Fall back to xyflow's typical defaults when the node has no explicit
    // measured size yet (e.g. a freshly added node mid-frame).
    const footprint = {
      x: abs.x,
      y: abs.y,
      width: width || 200,
      height: height || 100,
    };
    const rect = mark ? blendedMarkRect(mark) : footprint;
    const w = rect.width * zoom;
    const h = rect.height * zoom;
    const left = rect.x * zoom + vpX;
    const top = rect.y * zoom + vpY;

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
          outlineOffset: mark ? easeToward(0, 2, mark.progress) : 0,
          // Eased to a full circle as the card collapses. `collapsedRadius`
          // makes the box exactly as wide as the mark's disc is across, so at
          // the end a circular outline hugs the mark with zero gap, while any
          // squarer corner exposes up to 0.41r of bare canvas at each corner —
          // which reads as a white plate behind the mark rather than a ring
          // around it.
          borderRadius: mark
            ? easeToward(NODE_RADIUS_PX * zoom, w / 2, mark.progress)
            : NODE_RADIUS_PX * zoom,
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
