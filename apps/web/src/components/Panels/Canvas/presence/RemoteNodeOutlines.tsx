// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode, useViewport } from '@xyflow/react';
import { memo, useMemo } from 'react';

import { useCanvasPresenceStore } from '@/store/canvasPresence/canvasPresenceStore';

import { presenceColor, remoteNodeOutlines } from './presencePaint';
import { usePresenceLabel } from './usePresenceLabel';
import { SelectionOutline } from '../selectionChrome/SelectionOutline';
import {
  selectionOutlineRadius,
  selectionOutlineSize,
} from '../SelectionOutlines';
import { useRenderedNodeGeometry } from '../useRenderedNodeGeometry';

import type { RemoteNodeOutline } from './presencePaint';
import type { CanvasNode } from '@/components/Nodes/types';

/** Gap between a node and the first remote outline, and between stacked ones. */
const OUTLINE_GAP = 3;
const LABEL_HEIGHT = 16;

interface RemoteOutlineProps {
  outline: RemoteNodeOutline;
  label: string | null;
  domNode: HTMLDivElement;
  zoom: number;
  viewportX: number;
  viewportY: number;
}

const RemoteOutline = memo(function RemoteOutline({
  outline,
  label,
  domNode,
  zoom,
  viewportX,
  viewportY,
}: RemoteOutlineProps) {
  const internalNode = useInternalNode<CanvasNode>(outline.nodeId);
  const position = internalNode?.internals.positionAbsolute;
  const size = internalNode
    ? selectionOutlineSize(internalNode, internalNode)
    : { width: 0, height: 0 };
  const visible = internalNode !== undefined && !internalNode.hidden;
  // Same measured border box the page's own selection outline follows, so a
  // collapsed or content-sized node is outlined where it is actually drawn.
  const { geometry } = useRenderedNodeGeometry(
    outline.nodeId,
    domNode,
    false,
    {
      nodeX: position?.x ?? 0,
      nodeY: position?.y ?? 0,
      nodeWidth: size.width,
      nodeHeight: size.height,
      viewportX,
      viewportY,
      zoom,
    },
    visible,
  );
  // A node this page does not have (yet, or any more) has nothing to outline.
  if (!visible || !position) return null;
  const rect = geometry ?? {
    x: position.x * zoom + viewportX,
    y: position.y * zoom + viewportY,
    width: size.width * zoom,
    height: size.height * zoom,
    radius:
      selectionOutlineRadius(internalNode.type, size.width, size.height) * zoom,
  };
  const color = presenceColor(outline.colorIndex);
  const offset = OUTLINE_GAP * (outline.slot + 1);
  return (
    <>
      <SelectionOutline
        data-canvas-grounding-exclude
        data-presence-outline={outline.nodeId}
        data-presence-page={outline.pageId}
        data-presence-activity={outline.activity}
        data-presence-color={outline.colorIndex}
        className="z-998"
        rect={rect}
        radius={rect.radius}
        variant="offset"
        outlineOffset={offset}
        color={color}
      />
      {label !== null && (
        <span
          aria-hidden
          data-canvas-grounding-exclude
          data-presence-outline-label={outline.nodeId}
          className="text-fg-inverse pointer-events-none absolute z-998 rounded-sm px-1 text-[10px] leading-4 font-medium whitespace-nowrap"
          style={{
            left: rect.x - offset,
            top: rect.y - offset - LABEL_HEIGHT - 2,
            height: LABEL_HEIGHT,
            backgroundColor: color,
          }}
        >
          {label}
        </span>
      )}
    </>
  );
});

/**
 * Outlines, in each other page's colour, around the nodes that page has
 * selected, is dragging or is editing. Drawn outside this page's own
 * selection outline so both stay visible on the same node.
 *
 * Reads `pages`, which keeps its identity across pointer ticks, and the
 * React Flow store per node; it never touches `canvasStore.nodes`.
 */
export function RemoteNodeOutlines({ domNode }: { domNode: HTMLDivElement }) {
  const pages = useCanvasPresenceStore((state) => state.pages);
  const { x: viewportX, y: viewportY, zoom } = useViewport();
  const labelOf = usePresenceLabel();
  const outlines = useMemo(() => remoteNodeOutlines(pages), [pages]);
  if (outlines.length === 0) return null;
  return (
    <>
      {outlines.map((outline) => {
        const page = pages[outline.pageId];
        return (
          <RemoteOutline
            key={`${outline.pageId}:${outline.nodeId}`}
            outline={outline}
            label={
              page && outline.labelled ? labelOf(page, outline.activity) : null
            }
            domNode={domNode}
            zoom={zoom}
            viewportX={viewportX}
            viewportY={viewportY}
          />
        );
      })}
    </>
  );
}
