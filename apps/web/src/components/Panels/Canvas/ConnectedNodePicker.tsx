// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  getBezierPath,
  Position,
  useInternalNode,
  ViewportPortal,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { applyEdgeStyle } from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button.tsx';
import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover.tsx';
import {
  CONNECTED_NODE_EDGE_STYLE,
  SIDE_POSITION,
  type ConnectedNodeKind,
  type Side,
} from '@/components/Nodes/NodeConnectAffordance.tsx';
import { NODE_ICON } from '@/config/nodeIcons.ts';

/** Where a pending connection starts and ends, in flow coordinates. */
export interface PendingConnectionTether {
  /** Node the connection was dragged from. */
  nodeId: string;
  /** Port the connection left the node through. */
  side: Side;
  /** Flow-space point the gesture was released at. */
  to: { x: number; y: number };
}

/** Where the free end of the pending edge points back towards. */
const OPPOSITE_POSITION: Record<Side, Position> = {
  top: Position.Bottom,
  right: Position.Left,
  bottom: Position.Top,
  left: Position.Right,
};

/** Only one pending edge exists at a time, so a fixed marker id is safe. */
const PENDING_ARROW_ID = 'huabu-pending-connection-arrow';

/**
 * The edge the user just drew, held on screen while they pick a node type.
 *
 * Releasing the drag tears down React Flow's own connection line, so
 * without this the popover would appear detached from its source and the
 * gesture would read as "a menu opened", not "this edge needs a node at
 * its end".
 *
 * Painted as the finished edge rather than as a dashed hint: the stroke,
 * width and arrowhead all come from running the real creation style
 * through `applyEdgeStyle`, and the geometry is the same bezier
 * `LabelledEdge` falls back to. Committing the pick should change what
 * the edge is attached to, not what it looks like.
 */
function PendingConnectionEdge({ nodeId, side, to }: PendingConnectionTether) {
  const node = useInternalNode(nodeId);

  const { stroke, strokeWidth, hasArrow } = useMemo(() => {
    const edge = applyEdgeStyle(
      { id: PENDING_ARROW_ID, source: '', target: '' },
      CONNECTED_NODE_EDGE_STYLE,
    );
    return {
      stroke:
        typeof edge.style?.stroke === 'string' ? edge.style.stroke : undefined,
      strokeWidth:
        typeof edge.style?.strokeWidth === 'number'
          ? edge.style.strokeWidth
          : undefined,
      hasArrow: edge.markerEnd !== undefined,
    };
  }, []);

  const path = useMemo(() => {
    if (!node) return null;
    const { x, y } = node.internals.positionAbsolute;
    const w = node.measured.width ?? 0;
    const h = node.measured.height ?? 0;
    const from =
      side === 'top'
        ? { x: x + w / 2, y }
        : side === 'bottom'
          ? { x: x + w / 2, y: y + h }
          : side === 'left'
            ? { x, y: y + h / 2 }
            : { x: x + w, y: y + h / 2 };
    const [d] = getBezierPath({
      sourceX: from.x,
      sourceY: from.y,
      sourcePosition: SIDE_POSITION[side],
      targetX: to.x,
      targetY: to.y,
      targetPosition: OPPOSITE_POSITION[side],
    });
    return d;
  }, [node, side, to.x, to.y]);

  if (!path) return null;

  return (
    <ViewportPortal>
      {/*
        Anchored at the flow origin with `overflow-visible` so the path can
        be drawn straight in flow coordinates instead of into a fitted
        viewBox. Same z-index band as the selection lasso so it stays above
        opaque node bodies. Strokes are deliberately left to scale with the
        viewport transform, exactly as committed edges do.
      */}
      <svg
        className="pointer-events-none absolute overflow-visible"
        style={{ left: 0, top: 0, width: 1, height: 1, zIndex: 50 }}
      >
        {hasArrow && (
          <defs>
            {/* Geometry mirrors React Flow's built-in `arrowclosed` marker. */}
            <marker
              id={PENDING_ARROW_ID}
              markerWidth="12.5"
              markerHeight="12.5"
              viewBox="-10 -10 20 20"
              markerUnits="strokeWidth"
              orient="auto-start-reverse"
              refX="0"
              refY="0"
            >
              <polyline
                points="-5,-4 0,0 -5,4 -5,-4"
                style={{ stroke, fill: stroke, strokeWidth: 1 }}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </marker>
          </defs>
        )}
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          markerEnd={hasArrow ? `url(#${PENDING_ARROW_ID})` : undefined}
        />
      </svg>
    </ViewportPortal>
  );
}

interface ConnectedNodePickerProps {
  /**
   * Flow-space point the picker is anchored to (where the connect
   * gesture ended). `null` closes the picker.
   */
  anchor: { x: number; y: number } | null;
  /**
   * Pending edge to keep drawn while the picker is open. `null` for a
   * plain port click, where the source and the anchor coincide and the
   * edge would collapse to a point.
   */
  tether: PendingConnectionTether | null;
  onSelect: (kind: ConnectedNodeKind) => void;
  onDismiss: () => void;
}

/**
 * Node-type picker shown after a connect gesture that did not land on an
 * existing node.
 *
 * The gesture already decided *where* the new node goes (clicking a port
 * auto-aligns it off that side, dragging a port to empty canvas drops it
 * at the release point), so this picker only decides *what* it is. That
 * split is what lets the four ports replace the old four ports + four
 * direction arrows.
 */
export function ConnectedNodePicker({
  anchor,
  tether,
  onSelect,
  onDismiss,
}: ConnectedNodePickerProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const open = anchor !== null;

  // The picker portals to the end of `document.body`, so a keyboard user
  // who opened it from a port would otherwise have to tab through the
  // whole canvas to reach the two choices their own keypress produced.
  // Move focus onto the first choice and remember who had it, so
  // dismissing hands it back to the port they started from.
  useEffect(() => {
    if (!open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    rootRef.current?.querySelector('button')?.focus();
  }, [open]);

  const dismiss = useCallback(() => {
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus();
    onDismiss();
  }, [onDismiss]);

  const select = useCallback(
    (kind: ConnectedNodeKind) => {
      // Deliberately *not* restoring focus: the node being created may
      // open its own editor (a question node composes immediately), and
      // handing focus back to the source port would steal it straight
      // back out of that editor.
      openerRef.current = null;
      onSelect(kind);
    },
    [onSelect],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, dismiss]);

  return (
    <>
      {anchor && tether && <PendingConnectionEdge {...tether} />}
      <CanvasFloatingPopover
        anchor={anchor ? { ...anchor, width: 0, height: 0 } : null}
        open={open}
        offset={12}
        side="top"
        className="bg-surface shadow-bottom text-fg-muted flex items-center gap-1 rounded-lg p-1.5"
      >
        <div
          ref={rootRef}
          role="group"
          aria-label={t('node.createConnectedNode')}
          className="flex items-center gap-1"
        >
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            title={t('node.newNote')}
            onClick={() => select('note')}
          >
            <NODE_ICON.note />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            title={t('node.newQuestion')}
            onClick={() => select('question')}
          >
            <NODE_ICON.question />
          </Button>
        </div>
      </CanvasFloatingPopover>
    </>
  );
}
