import {
  autoUpdate,
  flip,
  offset as offsetMiddleware,
  shift,
  useFloating,
} from '@floating-ui/react';
import { useStore, useViewport } from '@xyflow/react';
import {
  useLayoutEffect,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import useCanvasStore from '@/store/canvasStore';
import { usePreviewStore } from '@/store/previewStore';

/**
 * A rectangle in flow (canvas) coordinates. For point-based anchors
 * (e.g. an edge midpoint) pass `width: 0` and `height: 0`.
 */
export interface CanvasAnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasFloatingPopoverProps {
  /**
   * Anchor rectangle in flow (canvas) coordinates. The popover is
   * horizontally centred over the anchor and placed on the preferred
   * `side` (flipping to the other side when there isn't enough room).
   */
  anchor: CanvasAnchorRect | null;
  /** When `false`, nothing is rendered. */
  open: boolean;
  /** Screen-pixel gap between the popover and the anchor. Default `12`. */
  offset?: number;
  /** Minimum gap to the visible browser viewport edges. Default `8`. */
  viewportPadding?: number;
  /** Preferred placement relative to the anchor. Default `'top'`. */
  side?: 'top' | 'bottom';
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * A floating popover anchored to a flow-space rectangle that portals
 * straight into `document.body`.
 *
 * Why portal to `document.body` and not into `.react-flow`?
 * React Flow's root container has `overflow: hidden`, which clips any
 * absolutely-positioned child that extends past its edges. Anchoring a
 * toolbar to a node near the canvas top edge would therefore cause the
 * toolbar to disappear under the page header — z-index can't help
 * because the toolbar is never painted to begin with.
 *
 * Positioning is delegated to Floating UI: a virtual reference element
 * exposes the anchor's page-space rect (computed from the React Flow
 * viewport transform plus the canvas container's bounding rect), and
 * the `offset` / `flip` / `shift` middleware handle gap, side flipping,
 * and viewport clamping. `autoUpdate` keeps the popover positioned
 * across scroll, resize, and ancestor mutations without a single
 * manual subscription.
 *
 * Used by `NodeWrapper` (per-node toolbar), `MultiSelectToolbar`, and
 * `EdgeStyleToolbar`. Every floating canvas surface should funnel
 * through this component to inherit the same clipping-free behaviour.
 */
export function CanvasFloatingPopover({
  anchor,
  open,
  offset = 12,
  viewportPadding = 8,
  side = 'top',
  className,
  style,
  children,
}: CanvasFloatingPopoverProps) {
  const { zoom, x: vpX, y: vpY } = useViewport();
  const domNode = useStore((s) => s.domNode);

  // Hide whenever the canvas is fully replaced by the ExpandedNodePanel
  // (node edit or preview in 'replace' mode). The canvas itself is kept
  // mounted at 0% width in that state, so anchor rectangles still resolve
  // to on-screen coordinates and the portal'd toolbar would otherwise
  // leak through on top of the expanded panel.
  const canvasReplaced = useCanvasStore(
    (s) => s.expandedNodeId !== null && s.expandMode === 'replace',
  );
  const previewReplaced = usePreviewStore(
    (s) =>
      s.previewType !== null &&
      s.previewData !== null &&
      s.expandMode === 'replace',
  );
  const hiddenByExpandedPanel = canvasReplaced || previewReplaced;

  // Virtual reference element: Floating UI calls `getBoundingClientRect`
  // on every position recalculation, so we always read fresh values
  // from the live React Flow container. The identity changes whenever
  // the viewport transform or anchor rect changes, which is what
  // triggers a re-position.
  const virtualReference = useMemo(() => {
    if (!domNode || !anchor) return null;
    return {
      getBoundingClientRect: () => {
        const containerRect = domNode.getBoundingClientRect();
        const left = containerRect.left + anchor.x * zoom + vpX;
        const top = containerRect.top + anchor.y * zoom + vpY;
        const width = anchor.width * zoom;
        const height = anchor.height * zoom;
        return {
          x: left,
          y: top,
          left,
          top,
          right: left + width,
          bottom: top + height,
          width,
          height,
        };
      },
    };
  }, [domNode, anchor, zoom, vpX, vpY]);

  const { refs, floatingStyles, isPositioned } = useFloating({
    open: open && !!virtualReference,
    placement: side,
    middleware: [
      offsetMiddleware(offset),
      flip({ padding: viewportPadding }),
      shift({ padding: viewportPadding }),
    ],
    whileElementsMounted: autoUpdate,
  });

  // Attach the virtual reference imperatively. `elements.reference` in
  // `@floating-ui/react` is typed as `Element | null`, but virtual
  // elements (with just `getBoundingClientRect`) are first-class
  // citizens at runtime — `setPositionReference` is the documented
  // entry point for them.
  useLayoutEffect(() => {
    refs.setPositionReference(virtualReference);
  }, [refs, virtualReference]);

  if (!open || !virtualReference || hiddenByExpandedPanel) return null;

  return createPortal(
    <div
      ref={refs.setFloating}
      className={className}
      style={{
        ...floatingStyles,
        zIndex: 1000,
        pointerEvents: 'auto',
        // Hide for the brief moment before the first measurement lands
        // so the popover doesn't flash at the top-left corner.
        visibility: isPositioned ? 'visible' : 'hidden',
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
