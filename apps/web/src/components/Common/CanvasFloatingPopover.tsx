// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

import { useCanvasAttentionStore } from '@/store/canvasAttentionStore';
import { useAnyGlobalModalOpen } from '@/store/globalModalUi';

import { FLOATING_CHROME_PROPS } from './floatingChrome';

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

  // Hide whenever an app-wide modal (Settings / Keyboard Shortcuts) is
  // open. Those modals render their own dimmed backdrop over the whole
  // window, but canvas floating toolbars portal to `document.body` at
  // z-index 1000 and would otherwise paint on top of the backdrop —
  // leaving two competing floating layers on screen at once.
  const hiddenByGlobalModal = useAnyGlobalModalOpen();

  // Hide whenever the user has moved on to another surface — the preview
  // workspace, the layer panel. Selection is
  // deliberately *not* cleared in that case (coming back should resume
  // where they left off), but chrome that belongs to a surface nobody is
  // working in is pure noise. Clicking anywhere on the canvas — including
  // re-clicking the same node — restores it.
  const hiddenByOtherSurface = useCanvasAttentionStore(
    (s) => !s.isCanvasEngaged,
  );

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

  // Constrain `flip` / `shift` to the canvas container's rect instead of
  // the browser viewport. Without this, a toolbar anchored to a node near
  // the canvas's right edge would freely overflow into the adjacent
  // ChatPanel / Split-mode ExpandedNodePanel (the portal renders at
  // z-index 1000, so it paints *on top of* those panels and visually
  // covers them). Using the React Flow container as the boundary makes
  // `shift` push the toolbar back inside the canvas and `flip` choose the
  // opposite side when there isn't room — so the popover never crosses
  // into neighbouring panels. Falls back to the viewport when `domNode`
  // isn't ready yet (first frame after mount).
  const { refs, floatingStyles, isPositioned, update } = useFloating({
    open: open && !!virtualReference,
    placement: side,
    middleware: [
      offsetMiddleware(offset),
      flip({ boundary: domNode ?? undefined, padding: viewportPadding }),
      shift({ boundary: domNode ?? undefined, padding: viewportPadding }),
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

  // `autoUpdate` only watches the reference (virtual — no real DOM
  // ancestors) and the floating element (portal'd to `document.body`,
  // also outside the canvas tree), so it never sees the canvas
  // container resize when the user toggles / drags the ChatPanel or
  // opens a Split-mode preview. Without an explicit observer, a toolbar
  // that was placed *before* the panel expanded would keep its old
  // screen position and bleed onto the freshly-revealed panel.
  // ResizeObserver on `domNode` triggers `update()` on every layout
  // frame the canvas resizes (including during the width transition),
  // re-running `shift` / `flip` against the new boundary rect.
  useLayoutEffect(() => {
    if (!domNode) return;
    const observer = new ResizeObserver(() => update());
    observer.observe(domNode);
    return () => observer.disconnect();
  }, [domNode, update]);

  if (!open || !virtualReference || hiddenByGlobalModal || hiddenByOtherSurface)
    return null;

  return createPortal(
    <div
      ref={refs.setFloating}
      {...FLOATING_CHROME_PROPS}
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
