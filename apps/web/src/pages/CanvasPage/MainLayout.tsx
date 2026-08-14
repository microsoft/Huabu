// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Loading } from '@/components/Common/Loading';
import { usePanelStore } from '@/store/panelStore';
import { openChat } from '@/store/previewWorkspace/actions';

interface MainLayoutProps {
  header: React.ReactNode;
  leftPanel: React.ReactNode;
  rightPanel: React.ReactNode;
  children: React.ReactNode;
}

interface LayoutInjectedProps {
  isCollapsed?: boolean;
  isHostCollapsed?: boolean;
  isFullscreen?: boolean;
  compact?: boolean;
  vertical?: boolean;
  onToggle?: () => void;
  onToggleFullscreen?: () => void;
  onOpenChat?: typeof openChat;
}

export function resolveRightPanelVisible({
  collapsed,
  moving,
  animatedVisible,
}: {
  collapsed: boolean;
  moving: boolean;
  animatedVisible: boolean;
}): boolean {
  return moving ? animatedVisible : !collapsed;
}

export const MainLayout = ({
  header,
  leftPanel,
  rightPanel,
  children,
}: MainLayoutProps) => {
  // Both side-panel collapse states live in `panelStore`. Left was
  // moved there earlier so the layer panel subtree could freeze its
  // `nodes` ref while collapsed (skipping the O(N) tree rebuild); right
  // followed so the open/closed state survives refresh + canvas re-entry
  // via the store's `persist` config — including the case where the
  // user left the chat panel open on a question replay.
  const isLeftCollapsed = usePanelStore((s) => s.isLeftCollapsed);
  const toggleLeftPanel = usePanelStore((s) => s.toggleLeftPanel);
  const isRightCollapsed = usePanelStore((s) => s.isRightCollapsed);
  const toggleRightPanel = usePanelStore((s) => s.toggleRightPanel);
  const isPreviewFullscreen = usePanelStore((s) => s.isPreviewFullscreen);
  const togglePreviewFullscreen = usePanelStore(
    (s) => s.togglePreviewFullscreen,
  );

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

  // Layers keeps a ratio cap. Preview instead uses all space left after the
  // Layers column and minimum Canvas width, allowing wide document browsing.
  const LEFT_MAX_RATIO = 0.3;

  const LEFT_DEFAULT_WIDTH_PX = 260;
  const RIGHT_DEFAULT_WIDTH_PX = 420;

  const [leftWidthPx, setLeftWidthPx] = useState(LEFT_DEFAULT_WIDTH_PX);
  const [rightWidthPx, setRightWidthPx] = useState(RIGHT_DEFAULT_WIDTH_PX);
  // Suspends width transition while the user drags a resize handle so the
  // panel tracks the cursor 1:1 instead of animating each pointer-move.
  const [isResizing, setIsResizing] = useState(false);
  const [isRightPanelVisible, setIsRightPanelVisible] =
    useState(!isRightCollapsed);
  const [isRightPanelMoving, setIsRightPanelMoving] = useState(false);
  const [isRestoringCanvas, setIsRestoringCanvas] = useState(false);
  const committedRightCollapsedRef = useRef(isRightCollapsed);
  const rightPanelMotionFallbackRef = useRef<number | null>(null);
  const restoreCanvasFrameRef = useRef<number | null>(null);

  const displayedPreviewFullscreen = isPreviewFullscreen && !isRestoringCanvas;

  const handleTogglePreviewFullscreen = () => {
    if (!isPreviewFullscreen) {
      togglePreviewFullscreen();
      return;
    }
    if (isRestoringCanvas) return;

    setIsRestoringCanvas(true);
    // Let the ordinary layout and loading indicator reach the screen before
    // React synchronously rebuilds the expensive Canvas/React Flow subtree.
    restoreCanvasFrameRef.current = requestAnimationFrame(() => {
      restoreCanvasFrameRef.current = requestAnimationFrame(() => {
        restoreCanvasFrameRef.current = null;
        togglePreviewFullscreen();
      });
    });
  };

  useEffect(() => {
    if (!isPreviewFullscreen) setIsRestoringCanvas(false);
    return () => {
      if (restoreCanvasFrameRef.current !== null) {
        cancelAnimationFrame(restoreCanvasFrameRef.current);
        restoreCanvasFrameRef.current = null;
      }
    };
  }, [isPreviewFullscreen]);

  const finishRightPanelMotion = () => {
    if (rightPanelMotionFallbackRef.current !== null) {
      window.clearTimeout(rightPanelMotionFallbackRef.current);
      rightPanelMotionFallbackRef.current = null;
    }
    setIsRightPanelMoving(false);
  };

  // Commit the final flex layout immediately, then animate only compositor
  // transforms. The zero-width closing slot right-aligns its absolute child,
  // so the panel stays in its old visual position while it slides offscreen.
  useLayoutEffect(() => {
    if (committedRightCollapsedRef.current === isRightCollapsed) return;
    committedRightCollapsedRef.current = isRightCollapsed;
    setIsRightPanelMoving(true);

    const frame = requestAnimationFrame(() => {
      setIsRightPanelVisible(!isRightCollapsed);
      // `transitionend` is authoritative. This only covers reduced motion,
      // interrupted transitions, and environments that omit the event.
      rightPanelMotionFallbackRef.current = window.setTimeout(
        finishRightPanelMotion,
        300,
      );
    });

    return () => {
      cancelAnimationFrame(frame);
      if (rightPanelMotionFallbackRef.current !== null) {
        window.clearTimeout(rightPanelMotionFallbackRef.current);
        rightPanelMotionFallbackRef.current = null;
      }
      setIsRightPanelMoving(false);
    };
  }, [isRightCollapsed]);

  const rightPanelVisible =
    displayedPreviewFullscreen ||
    resolveRightPanelVisible({
      collapsed: isRightCollapsed,
      moving: isRightPanelMoving,
      animatedVisible: isRightPanelVisible,
    });
  const rightPanelMotionPending =
    isRightPanelMoving ||
    committedRightCollapsedRef.current !== isRightCollapsed;
  const clipSettledRightPanel = isRightCollapsed && !rightPanelMotionPending;

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
  const rightHandleDisabled =
    isRightCollapsed || displayedPreviewFullscreen || isRestoringCanvas;

  const leftHandleClassName = `${resizeHandleClassName} ${
    leftHandleDisabled ? 'hidden' : 'cursor-col-resize'
  }`;

  const rightHandleClassName = `${resizeHandleClassName} ${
    rightHandleDisabled ? 'hidden' : 'cursor-col-resize'
  }`;

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
      const maxLeft = displayedPreviewFullscreen
        ? totalWidth * LEFT_MAX_RATIO
        : Math.min(
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
      const maxRight =
        totalWidth - effectiveLeftWidthPx - dragConstraints.minCenter;
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
    <div
      ref={contentRef}
      className="relative flex h-full w-full overflow-hidden"
      data-preview-fullscreen={displayedPreviewFullscreen ? 'true' : undefined}
      data-canvas-restoring={isRestoringCanvas ? 'true' : undefined}
    >
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
              ? React.cloneElement(
                  header as React.ReactElement<LayoutInjectedProps>,
                  {
                    isCollapsed: false,
                    onToggle: toggleLeftPanel,
                    compact: true,
                  },
                )
              : header}
          </div>
          <div className="min-h-0 flex-1">
            {React.isValidElement(leftPanel)
              ? React.cloneElement(
                  leftPanel as React.ReactElement<LayoutInjectedProps>,
                  {
                    isCollapsed: false,
                    onToggle: toggleLeftPanel,
                  },
                )
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

      {/* Fullscreen Preview unmounts Canvas entirely. Hiding React Flow with
          CSS leaves portals and compositor layers alive, which can leak stale
          canvas pixels over Preview or Layers. Canvas restores its viewport
          from canvasStore when this subtree mounts again. */}
      {!displayedPreviewFullscreen && (
        <div
          className="relative min-w-0 flex-1"
          data-center-editor
          data-right-panel-motion={rightPanelMotionPending ? 'true' : undefined}
        >
          {isPreviewFullscreen ? (
            <Loading layout="block" className="bg-bg-default" />
          ) : React.isValidElement(children) ? (
            React.cloneElement(
              children as React.ReactElement<LayoutInjectedProps>,
              {
                onOpenChat: openChat,
              },
            )
          ) : (
            children
          )}
          {isLeftCollapsed && React.isValidElement(header) && (
            <div className="pointer-events-auto absolute top-3 left-2 z-30">
              {React.cloneElement(
                header as React.ReactElement<LayoutInjectedProps>,
                {
                  isCollapsed: true,
                  onToggle: toggleLeftPanel,
                  compact: true,
                },
              )}
            </div>
          )}
        </div>
      )}

      {displayedPreviewFullscreen &&
        isLeftCollapsed &&
        React.isValidElement(header) && (
          <div className="h-full w-12 shrink-0" data-fullscreen-header-rail>
            {React.cloneElement(
              header as React.ReactElement<LayoutInjectedProps>,
              {
                isCollapsed: true,
                onToggle: toggleLeftPanel,
                compact: true,
                vertical: true,
              },
            )}
          </div>
        )}

      {/* Right Resize Handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        className={rightHandleClassName}
        onPointerDown={onRightHandlePointerDown}
      >
        <div className={resizeHandleInnerClassName} />
      </div>

      {/* Right Panel — the outer slot jumps to its final width so Canvas only
          resizes once. The fixed-width inner panel and React Flow viewport
          then animate their compositor transforms to the same final layout.
          While closing, the zero-width slot right-aligns the absolute inner
          panel so it can slide offscreen instead of disappearing immediately. */}
      <div
        className={`relative ${
          displayedPreviewFullscreen ? 'min-w-0 flex-1' : 'shrink-0'
        } ${displayedPreviewFullscreen || clipSettledRightPanel ? 'overflow-hidden' : ''}`}
        data-right-panel-slot
        data-collapsed={isRightCollapsed ? 'true' : undefined}
        data-moving={isRightPanelMoving ? 'true' : undefined}
        data-resizing={isResizing ? 'true' : undefined}
        style={{
          width: displayedPreviewFullscreen
            ? undefined
            : `${effectiveRightWidthPx}px`,
        }}
      >
        <div
          className="absolute top-0 h-full"
          data-right-panel-content
          data-visible={rightPanelVisible ? 'true' : undefined}
          style={{
            width: displayedPreviewFullscreen ? '100%' : `${rightWidthPx}px`,
          }}
          onTransitionEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.propertyName === 'transform'
            ) {
              finishRightPanelMotion();
            }
          }}
        >
          {React.isValidElement(rightPanel)
            ? React.cloneElement(
                rightPanel as React.ReactElement<LayoutInjectedProps>,
                {
                  isCollapsed: false,
                  isHostCollapsed: isRightCollapsed,
                  onToggle: toggleRightPanel,
                  isFullscreen: displayedPreviewFullscreen,
                  onToggleFullscreen: handleTogglePreviewFullscreen,
                },
              )
            : rightPanel}
        </div>
      </div>
    </div>
  );
};
