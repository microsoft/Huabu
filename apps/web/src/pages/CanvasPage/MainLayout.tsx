import React, { useEffect, useMemo, useRef, useState } from 'react';

import { usePanelStore } from '@/store/panelStore';

interface MainLayoutProps {
  header: React.ReactNode;
  leftPanel: React.ReactNode;
  rightPanel: React.ReactNode;
  children: React.ReactNode;
}

export const MainLayout = ({
  header,
  leftPanel,
  rightPanel,
  children,
}: MainLayoutProps) => {
  // Left collapse lives in `panelStore` so the layer panel subtree can
  // read it and freeze its `nodes` ref while collapsed (skipping the
  // O(N) tree rebuild). Right collapse remains local because nothing
  // outside `MainLayout` needs to read it today.
  const isLeftCollapsed = usePanelStore((s) => s.isLeftCollapsed);
  const toggleLeftPanel = usePanelStore((s) => s.toggleLeftPanel);
  const [isRightCollapsed, setIsRightCollapsed] = useState(true);

  const contentRef = useRef<HTMLDivElement | null>(null);

  // Fixed pixel sizes to guarantee that collapsing side panels only affects
  // the center panel width. Both sides collapse to 0 so the canvas takes
  // over the full area; the Header and chat toggle are rendered as floating
  // overlays in that mode.
  const COLLAPSED_LEFT_WIDTH_PX = 0;
  const COLLAPSED_RIGHT_WIDTH_PX = 0;
  const LEFT_MIN_WIDTH_PX = 200;
  const RIGHT_MIN_WIDTH_PX = 264;
  const CENTER_MIN_WIDTH_PX = 100;

  // Maximum side panel widths as ratios of the available content width.
  // This mirrors the previous maxSize behavior when using react-resizable-panels.
  const LEFT_MAX_RATIO = 0.3;
  const RIGHT_MAX_RATIO = 0.5;

  const LEFT_DEFAULT_WIDTH_PX = 260;
  const RIGHT_DEFAULT_WIDTH_PX = 420;

  const [leftWidthPx, setLeftWidthPx] = useState(LEFT_DEFAULT_WIDTH_PX);
  const [rightWidthPx, setRightWidthPx] = useState(RIGHT_DEFAULT_WIDTH_PX);
  // Suspends width transition while the user drags a resize handle so the
  // panel tracks the cursor 1:1 instead of animating each pointer-move.
  const [isResizing, setIsResizing] = useState(false);

  const effectiveLeftWidthPx = isLeftCollapsed
    ? COLLAPSED_LEFT_WIDTH_PX
    : leftWidthPx;
  const effectiveRightWidthPx = isRightCollapsed
    ? COLLAPSED_RIGHT_WIDTH_PX
    : rightWidthPx;

  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

  const resizeHandleClassName =
    'group flex w-1 shrink-0 items-center justify-center bg-transparent outline-none';
  const resizeHandleInnerClassName =
    'h-8 w-0.5 rounded-full bg-text-faded opacity-0 transition-all duration-300 group-hover:h-12 group-hover:opacity-100';

  const leftHandleDisabled = isLeftCollapsed;
  const rightHandleDisabled = isRightCollapsed;

  const leftHandleClassName = `${resizeHandleClassName} ${
    leftHandleDisabled
      ? 'pointer-events-none w-0 opacity-0'
      : 'cursor-col-resize'
  }`;

  const rightHandleClassName = `${resizeHandleClassName} ${
    rightHandleDisabled
      ? 'pointer-events-none w-0 opacity-0'
      : 'cursor-col-resize'
  }`;

  const toggleRightPanel = () => {
    setIsRightCollapsed((prev) => !prev);
  };

  // Open right panel programmatically when requested via panelStore
  const openRequest = usePanelStore((s) => s.rightPanelOpenRequest);
  useEffect(() => {
    if (openRequest > 0) {
      setIsRightCollapsed(false);
    }
  }, [openRequest]);

  const dragConstraints = useMemo(() => {
    const totalWidth = contentRef.current?.getBoundingClientRect().width ?? 0;
    return {
      totalWidth,
      minLeft: LEFT_MIN_WIDTH_PX,
      minRight: RIGHT_MIN_WIDTH_PX,
      minCenter: CENTER_MIN_WIDTH_PX,
    };
  }, [LEFT_MIN_WIDTH_PX, RIGHT_MIN_WIDTH_PX, CENTER_MIN_WIDTH_PX]);

  const onLeftHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (leftHandleDisabled) return;

    const startX = e.clientX;
    const startLeft = leftWidthPx;

    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setIsResizing(true);

    const onMove = (ev: PointerEvent) => {
      const totalWidth =
        contentRef.current?.getBoundingClientRect().width ??
        dragConstraints.totalWidth;
      const maxLeft = Math.min(
        totalWidth - effectiveRightWidthPx - dragConstraints.minCenter,
        totalWidth * LEFT_MAX_RATIO,
      );
      const nextLeft = clamp(
        startLeft + (ev.clientX - startX),
        dragConstraints.minLeft,
        maxLeft,
      );
      setLeftWidthPx(nextLeft);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setIsResizing(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onRightHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (rightHandleDisabled) return;

    const startX = e.clientX;
    const startRight = rightWidthPx;

    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setIsResizing(true);

    const onMove = (ev: PointerEvent) => {
      const totalWidth =
        contentRef.current?.getBoundingClientRect().width ??
        dragConstraints.totalWidth;
      const maxRight = Math.min(
        totalWidth - effectiveLeftWidthPx - dragConstraints.minCenter,
        totalWidth * RIGHT_MAX_RATIO,
      );
      // Dragging right handle to the right makes the right panel smaller.
      const nextRight = clamp(
        startRight - (ev.clientX - startX),
        dragConstraints.minRight,
        maxRight,
      );
      setRightWidthPx(nextRight);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setIsResizing(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div ref={contentRef} className="flex h-full w-full overflow-hidden">
      {/* Left Column: Header on top, Left Panel below — share the same width.
          When collapsed the column shrinks to 0; the Header is rendered as a
          floating overlay in the center area below. Children are kept mounted
          but always in their expanded form so the parent's `overflow-hidden`
          can cleanly clip them as the width animates to 0 — otherwise the
          SidebarPanel's own collapsed 36px strip would briefly appear and
          look like a vertical sliver pinned to the left edge.

          The inner content is absolutely positioned at the natural expanded
          width (`leftWidthPx`). Pinning the inner width decouples row
          layout (truncate ellipsis, `ml-auto` action cluster, icon flex)
          from the animated outer width — otherwise every frame of the
          220ms transition would re-truncate labels and shift the action
          cluster, producing visible jank. The outer simply clips the
          inner via `overflow-hidden`. */}
      <div
        className="relative shrink-0 overflow-hidden"
        data-animate-width
        data-resizing={isResizing ? 'true' : undefined}
        style={{
          width: `${effectiveLeftWidthPx}px`,
        }}
      >
        <div
          className="absolute top-0 left-0 flex h-full flex-col"
          style={{ width: `${leftWidthPx}px` }}
        >
          <div className="shrink-0">
            {React.isValidElement(header)
              ? React.cloneElement(header as React.ReactElement<any>, {
                  isCollapsed: false,
                  onToggle: toggleLeftPanel,
                  compact: true,
                })
              : header}
          </div>
          <div className="min-h-0 flex-1">
            {React.isValidElement(leftPanel)
              ? React.cloneElement(leftPanel as React.ReactElement<any>, {
                  isCollapsed: false,
                  onToggle: toggleLeftPanel,
                })
              : leftPanel}
          </div>
        </div>
      </div>

      {/* Left Resize Handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        className={leftHandleClassName}
        onPointerDown={onLeftHandlePointerDown}
      >
        <div className={resizeHandleInnerClassName} />
      </div>

      {/* Center Editor — hosts the canvas and the floating Header overlay
          when the left panel is collapsed. The chat collapse state is
          forwarded to children so they can render their own top-right
          floating controls (chat toggle + settings). */}
      <div className="relative min-w-0 flex-1">
        {React.isValidElement(children)
          ? React.cloneElement(children as React.ReactElement<any>, {
              isChatCollapsed: isRightCollapsed,
              onToggleChat: toggleRightPanel,
            })
          : children}
        {isLeftCollapsed && React.isValidElement(header) && (
          <div className="pointer-events-auto absolute top-3 left-2 z-30">
            {React.cloneElement(header as React.ReactElement<any>, {
              isCollapsed: true,
              onToggle: toggleLeftPanel,
              compact: true,
            })}
          </div>
        )}
      </div>

      {/* Right Resize Handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        className={rightHandleClassName}
        onPointerDown={onRightHandlePointerDown}
      >
        <div className={resizeHandleInnerClassName} />
      </div>

      {/* Right Panel — spans full height. When collapsed the column shrinks
          to 0 and `overflow-hidden` clips it; the panel is always rendered
          in its expanded form so the SidebarPanel's own collapsed strip
          never flashes during the width animation (mirrors the left
          column's behavior). The chat-toggle button lives as a floating
          overlay in the center area when collapsed. */}
      <div
        className="shrink-0 overflow-hidden"
        data-animate-width
        data-resizing={isResizing ? 'true' : undefined}
        style={{
          width: `${effectiveRightWidthPx}px`,
        }}
      >
        {React.isValidElement(rightPanel)
          ? React.cloneElement(rightPanel as React.ReactElement<any>, {
              isCollapsed: false,
              onToggle: toggleRightPanel,
            })
          : rightPanel}
      </div>
    </div>
  );
};
