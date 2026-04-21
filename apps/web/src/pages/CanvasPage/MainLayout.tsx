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
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(true);
  const [isRightCollapsed, setIsRightCollapsed] = useState(true);

  const contentRef = useRef<HTMLDivElement | null>(null);

  // Fixed pixel sizes to guarantee that collapsing side panels only affects
  // the center panel width.
  const COLLAPSED_WIDTH_PX = 36;
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

  const effectiveLeftWidthPx = isLeftCollapsed
    ? COLLAPSED_WIDTH_PX
    : leftWidthPx;
  const effectiveRightWidthPx = isRightCollapsed
    ? COLLAPSED_WIDTH_PX
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

  const toggleLeftPanel = () => {
    setIsLeftCollapsed((prev) => !prev);
  };

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
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Header Area */}
      <div className="shrink-0">{header}</div>

      {/* Main Content Area */}
      <div ref={contentRef} className="flex min-h-0 flex-1">
        {/* Left Panel */}
        <div
          className="shrink-0"
          style={{
            width: `${effectiveLeftWidthPx}px`,
          }}
        >
          {React.isValidElement(leftPanel)
            ? React.cloneElement(leftPanel as React.ReactElement<any>, {
                isCollapsed: isLeftCollapsed,
                onToggle: toggleLeftPanel,
              })
            : leftPanel}
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

        {/* Center Editor */}
        <div className="min-w-0 flex-1">{children}</div>

        {/* Right Resize Handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          className={rightHandleClassName}
          onPointerDown={onRightHandlePointerDown}
        >
          <div className={resizeHandleInnerClassName} />
        </div>

        {/* Right Panel */}
        <div
          className="shrink-0"
          style={{
            width: `${effectiveRightWidthPx}px`,
          }}
        >
          {React.isValidElement(rightPanel)
            ? React.cloneElement(rightPanel as React.ReactElement<any>, {
                isCollapsed: isRightCollapsed,
                onToggle: toggleRightPanel,
              })
            : rightPanel}
        </div>
      </div>
    </div>
  );
};
