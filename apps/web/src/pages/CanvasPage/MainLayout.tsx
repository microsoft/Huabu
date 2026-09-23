// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

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
  isContentMounted?: boolean;
  isHostCollapsed?: boolean;
  isFullscreen?: boolean;
  compact?: boolean;
  vertical?: boolean;
  onToggle?: () => void;
  onToggleFullscreen?: () => void;
  onOpenChat?: typeof openChat;
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
  const [focusedPanel, setFocusedPanel] = useState<string | null>(null);
  useLayoutEffect(
    () =>
      usePanelStore.subscribe((state, previous) => {
        const layout = contentRef.current;
        const active = document.activeElement;
        if (!layout || !(active instanceof HTMLElement)) return;
        const panel = active.closest<HTMLElement>('[data-canvas-panel]');
        if (!panel || !layout.contains(panel)) return;
        const hidesLeft =
          panel.dataset.canvasPanel === 'left' &&
          !previous.isLeftCollapsed &&
          state.isLeftCollapsed;
        const hidesRight =
          panel.dataset.canvasPanel === 'right' &&
          (!previous.isRightCollapsed || previous.isPreviewFullscreen) &&
          state.isRightCollapsed &&
          !state.isPreviewFullscreen;
        if (!hidesLeft && !hidesRight) return;
        const destination =
          layout.querySelector<HTMLElement>('[data-center-editor]') ??
          (hidesLeft && (!state.isRightCollapsed || state.isPreviewFullscreen)
            ? layout.querySelector<HTMLElement>('[data-canvas-panel="right"]')
            : null);
        (destination ?? layout).focus({ preventScroll: true });
      }),
    [],
  );
  useEffect(() => {
    const updateOwner = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const panel = target.closest<HTMLElement>('[data-canvas-panel]');
      if (panel && contentRef.current?.contains(panel)) {
        setFocusedPanel(panel.dataset.canvasPanel ?? null);
      } else if (
        !target.closest('[role="menu"], [role="dialog"], [role="listbox"]')
      ) {
        setFocusedPanel(null);
        if (
          event.type === 'pointerdown' &&
          target.closest('[data-center-editor]') &&
          !target.closest(
            'input, textarea, select, button, a[href], [contenteditable="true"]',
          )
        ) {
          target
            .closest<HTMLElement>('[data-center-editor]')
            ?.focus({ preventScroll: true });
        }
      }
    };
    document.addEventListener('focusin', updateOwner, true);
    document.addEventListener('pointerdown', updateOwner, true);
    return () => {
      document.removeEventListener('focusin', updateOwner, true);
      document.removeEventListener('pointerdown', updateOwner, true);
    };
  }, []);
  const focusPanel = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target;
    const control =
      target instanceof Element
        ? target.closest(
            'button, input, textarea, select, a[href], [contenteditable="true"], [tabindex]',
          )
        : null;
    if (!control || control === event.currentTarget) {
      event.currentTarget.focus({ preventScroll: true });
    }
  };

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
  const [retainLeftContent, setRetainLeftContent] = useState(!isLeftCollapsed);
  const leftContentMounted = !isLeftCollapsed || retainLeftContent;
  useLayoutEffect(() => {
    if (!isLeftCollapsed) {
      setRetainLeftContent(true);
      return;
    }
    const fallback = window.setTimeout(() => setRetainLeftContent(false), 300);
    return () => window.clearTimeout(fallback);
  }, [isLeftCollapsed]);
  const [isRestoringCanvas, setIsRestoringCanvas] = useState(false);
  const restoreCanvasFrameRef = useRef<number | null>(null);
  const [layoutWidth, setLayoutWidth] = useState<number | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setLayoutWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const displayedPreviewFullscreen = isPreviewFullscreen && !isRestoringCanvas;
  const [toolbarWidth, setToolbarWidth] = useState(0);
  useLayoutEffect(() => {
    const layout = contentRef.current;
    if (!layout || typeof ResizeObserver === 'undefined') return;
    let toolbar: HTMLElement | null = null;
    const observer = new ResizeObserver(() => {
      setToolbarWidth(toolbar?.getBoundingClientRect().width ?? 0);
    });
    const observeToolbar = () => {
      const next = layout.querySelector<HTMLElement>(
        '[data-canvas-main-toolbar]',
      );
      if (next === toolbar) return;
      observer.disconnect();
      toolbar = next;
      setToolbarWidth(toolbar?.getBoundingClientRect().width ?? 0);
      if (toolbar) observer.observe(toolbar);
    };
    const mutations = new MutationObserver(observeToolbar);
    const host = layout.querySelector('[data-canvas-toolbar-layer]');
    if (host) mutations.observe(host, { childList: true, subtree: true });
    observeToolbar();
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [displayedPreviewFullscreen]);

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

  const visibleLeftWidth =
    layoutWidth === null
      ? leftWidthPx
      : Math.min(leftWidthPx, layoutWidth * LEFT_MAX_RATIO);
  const effectiveLeftWidthPx = isLeftCollapsed
    ? COLLAPSED_LEFT_WIDTH_PX
    : visibleLeftWidth;
  const visibleRightWidth =
    layoutWidth === null
      ? rightWidthPx
      : Math.min(
          rightWidthPx,
          Math.max(0, layoutWidth - effectiveLeftWidthPx - CENTER_MIN_WIDTH_PX),
        );
  const effectiveRightWidthPx = isRightCollapsed
    ? COLLAPSED_RIGHT_WIDTH_PX
    : visibleRightWidth;
  const toolbarSideSpace = ((layoutWidth ?? 0) - toolbarWidth) / 2;
  const toolbarHidden =
    toolbarWidth > 0 &&
    layoutWidth !== null &&
    ((focusedPanel === 'left' && effectiveLeftWidthPx > toolbarSideSpace) ||
      (focusedPanel === 'right' && effectiveRightWidthPx > toolbarSideSpace));

  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

  const resizeHandleClassName =
    'absolute inset-y-0 z-10 w-1 touch-none bg-transparent outline-none';

  const leftHandleDisabled = isLeftCollapsed;
  const rightHandleDisabled =
    isRightCollapsed || displayedPreviewFullscreen || isRestoringCanvas;

  const leftHandleClassName = `${resizeHandleClassName} right-0 ${
    leftHandleDisabled ? 'hidden' : 'cursor-col-resize'
  }`;

  const rightHandleClassName = `${resizeHandleClassName} left-0 ${
    rightHandleDisabled ? 'hidden' : 'cursor-col-resize'
  }`;

  const onResizePointerDown = (
    side: 'left' | 'right',
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    const isLeft = side === 'left';
    const disabled = isLeft ? leftHandleDisabled : rightHandleDisabled;
    const layout = contentRef.current;
    if (disabled || event.button !== 0 || !layout) return;
    resizeCleanupRef.current?.();

    const startX = event.clientX;
    const startWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width ??
      (isLeft ? visibleLeftWidth : visibleRightWidth);
    const pointerId = event.pointerId;
    const setWidth = isLeft ? setLeftWidthPx : setRightWidthPx;
    event.currentTarget.setPointerCapture(pointerId);

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const totalWidth = layout.getBoundingClientRect().width;
      const maxWidth = isLeft
        ? displayedPreviewFullscreen
          ? totalWidth * LEFT_MAX_RATIO
          : Math.min(
              totalWidth - effectiveRightWidthPx - CENTER_MIN_WIDTH_PX,
              totalWidth * LEFT_MAX_RATIO,
            )
        : totalWidth - effectiveLeftWidthPx - CENTER_MIN_WIDTH_PX;
      setWidth(
        clamp(
          startWidth + (move.clientX - startX) * (isLeft ? 1 : -1),
          isLeft ? LEFT_MIN_WIDTH_PX : RIGHT_MIN_WIDTH_PX,
          maxWidth,
        ),
      );
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', cleanup);
      resizeCleanupRef.current = null;
    };
    const onEnd = (end: PointerEvent) => {
      if (end.pointerId === pointerId) cleanup();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', cleanup);
    resizeCleanupRef.current = cleanup;
  };

  return (
    <div
      ref={contentRef}
      className="relative flex h-full w-full overflow-clip"
      data-overlay-layout
      tabIndex={-1}
      style={
        {
          '--canvas-inset-left': `${effectiveLeftWidthPx}px`,
          '--canvas-inset-right': `${effectiveRightWidthPx}px`,
        } as React.CSSProperties
      }
      data-preview-fullscreen={displayedPreviewFullscreen ? 'true' : undefined}
      data-canvas-restoring={isRestoringCanvas ? 'true' : undefined}
    >
      <div
        className="bg-surface absolute inset-y-0 left-0 z-40 overflow-hidden outline-none"
        data-canvas-panel="left"
        data-collapsed={isLeftCollapsed ? 'true' : undefined}
        tabIndex={-1}
        onPointerDownCapture={focusPanel}
        onTransitionEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.propertyName === 'transform' &&
            usePanelStore.getState().isLeftCollapsed
          ) {
            setRetainLeftContent(false);
          }
        }}
        style={{
          width: `${visibleLeftWidth}px`,
        }}
      >
        <div
          className="absolute top-0 left-0 flex h-full flex-col"
          inert={isLeftCollapsed}
          style={{ width: '100%' }}
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
                    isContentMounted: leftContentMounted,
                    onToggle: toggleLeftPanel,
                  },
                )
              : leftPanel}
          </div>
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          className={leftHandleClassName}
          onPointerDown={(event) => onResizePointerDown('left', event)}
        />
      </div>

      {/* Fullscreen Preview unmounts Canvas entirely. Hiding React Flow with
          CSS leaves portals and compositor layers alive, which can leak stale
          canvas pixels over Preview or Layers. Canvas restores its viewport
          from canvasStore when this subtree mounts again. */}
      {!displayedPreviewFullscreen && (
        <div
          className="absolute inset-0 isolate"
          data-center-editor
          tabIndex={-1}
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
          <div
            className="absolute inset-y-0 left-0 z-40 h-full w-12"
            data-fullscreen-header-rail
            data-canvas-panel="rail"
          >
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

      <div
        className="bg-surface absolute inset-y-0 right-0 z-40 overflow-hidden outline-none"
        data-right-panel-slot
        data-canvas-panel="right"
        data-collapsed={
          isRightCollapsed && !displayedPreviewFullscreen ? 'true' : undefined
        }
        tabIndex={-1}
        onPointerDownCapture={focusPanel}
        style={{
          width: displayedPreviewFullscreen
            ? `calc(100% - ${isLeftCollapsed ? 48 : effectiveLeftWidthPx}px)`
            : `${visibleRightWidth}px`,
        }}
      >
        <div
          className="absolute top-0 h-full"
          data-right-panel-content
          inert={isRightCollapsed && !displayedPreviewFullscreen}
          style={{
            width: '100%',
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
        <div
          role="separator"
          aria-orientation="vertical"
          className={rightHandleClassName}
          onPointerDown={(event) => onResizePointerDown('right', event)}
        />
      </div>
      {!displayedPreviewFullscreen && (
        <div
          data-canvas-toolbar-layer
          data-hidden={toolbarHidden ? 'true' : undefined}
          inert={toolbarHidden}
          aria-hidden={toolbarHidden || undefined}
          className="pointer-events-none absolute inset-0 z-50"
        />
      )}
    </div>
  );
};
