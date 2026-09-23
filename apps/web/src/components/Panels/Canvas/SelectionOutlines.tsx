// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode, useStore, useViewport } from '@xyflow/react';
import { useMemo } from 'react';
import { createPortal } from 'react-dom';

import {
  getAbsolutePosition,
  isAlwaysAutoHeightNodeType,
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
import { SelectionOutline } from './selectionChrome/SelectionOutline';
import { useRenderedNodeGeometry } from './useRenderedNodeGeometry';
import { selectionOutlineRadius } from '../../Nodes/design/nodeSelectionGeometry';

export { selectionOutlineRadius } from '../../Nodes/design/nodeSelectionGeometry';

import type { CanvasNode } from '@/components/Nodes/types';
import type { InternalNode } from '@xyflow/react';

export function selectOutlinedNodes(
  nodes: readonly CanvasNode[],
): CanvasNode[] {
  return nodes.filter((node) => node.selected || node.dragging);
}

export function selectionOutlineSize(
  node: CanvasNode,
  internalNode: Pick<InternalNode, 'measured'> | undefined,
): { width: number; height: number } {
  const styleWidth = node.style?.width;
  const styleHeight = node.style?.height;
  const contentOwnsHeight = isAlwaysAutoHeightNodeType(node.type ?? '');
  return {
    width:
      (typeof styleWidth === 'number' ? styleWidth : undefined) ??
      internalNode?.measured.width ??
      node.measured?.width ??
      200,
    height:
      (!contentOwnsHeight && typeof styleHeight === 'number'
        ? styleHeight
        : undefined) ??
      internalNode?.measured.height ??
      node.measured?.height ??
      100,
  };
}

interface SelectionOutlineForNodeProps {
  node: CanvasNode;
  previewNodes: CanvasNode[];
  domNode: HTMLDivElement;
  zoom: number;
  viewportX: number;
  viewportY: number;
}

function SelectionOutlineForNode({
  node,
  previewNodes,
  domNode,
  zoom,
  viewportX,
  viewportY,
}: SelectionOutlineForNodeProps) {
  const internalNode = useInternalNode(node.id);
  const internalPosition = internalNode?.internals.positionAbsolute;
  const internalWidth =
    (internalNode?.style?.width as number | undefined) ??
    internalNode?.measured.width ??
    0;
  const internalHeight =
    (internalNode?.style?.height as number | undefined) ??
    internalNode?.measured.height ??
    0;
  const { geometry: renderedGeometry } = useRenderedNodeGeometry(
    node.id,
    domNode,
    internalNode?.resizing === true,
    {
      nodeX: internalPosition?.x ?? node.position.x,
      nodeY: internalPosition?.y ?? node.position.y,
      nodeWidth: internalWidth,
      nodeHeight: internalHeight,
      viewportX,
      viewportY,
      zoom,
    },
  );
  const hasGeometryPreview = useGesturePreviewStore((state) =>
    state.nodeGeometryPreviews?.has(node.id),
  );
  const mark = useNodeCollapseStore((state) => state.marks[node.id]);
  const abs = hasGeometryPreview
    ? (getAbsolutePosition(previewNodes as NestableNode[], node.id) ??
      node.position)
    : (internalPosition ?? node.position);
  const fallbackSize = selectionOutlineSize(node, internalNode);
  const { width, height } = renderedGeometry ?? fallbackSize;
  const footprint = { x: abs.x, y: abs.y, width, height };
  const rect = mark ? blendedMarkRect(mark) : footprint;
  const renderedRect =
    renderedGeometry && !mark
      ? renderedGeometry
      : {
          x: rect.x * zoom + viewportX,
          y: rect.y * zoom + viewportY,
          width: rect.width * zoom,
          height: rect.height * zoom,
          radius: selectionOutlineRadius(node.type, width, height) * zoom,
        };
  const shellRadius = renderedRect.radius;

  return (
    <SelectionOutline
      data-canvas-grounding-exclude
      data-node-selection-outline={node.id}
      className="pointer-events-none absolute z-998"
      rect={{
        x: renderedRect.x,
        y: renderedRect.y,
        width: renderedRect.width,
        height: renderedRect.height,
      }}
      variant={mark ? 'offset' : 'solid'}
      outlineOffset={mark ? easeToward(0, 2, mark.progress) : 0}
      radius={
        mark
          ? easeToward(shellRadius, renderedRect.width / 2, mark.progress)
          : shellRadius
      }
    />
  );
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
 *  - Opaque 1.5px solid `--color-info`, without a glow or type-specific fading.
 *  - `border-radius` uses the node shell's responsive size policy and scales
 *    with `zoom`, so the outline tracks the rendered corners at any view scale.
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

  const outlines = outlinedNodes.map((node) => (
    <SelectionOutlineForNode
      key={node.id}
      node={node}
      previewNodes={previewNodes}
      domNode={domNode}
      zoom={zoom}
      viewportX={vpX}
      viewportY={vpY}
    />
  ));

  return createPortal(<>{outlines}</>, domNode);
};
