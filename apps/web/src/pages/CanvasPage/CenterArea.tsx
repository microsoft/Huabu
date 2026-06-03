import { Bot, BookOpen } from 'lucide-react';
import React, { useCallback, useRef } from 'react';

import { Button } from '../../components/Common/Button';
import { cn } from '../../components/Common/cn';
import { Canvas } from '../../components/Panels/Canvas/Canvas';
import { ExpandedNodePanel } from '../../components/Panels/Canvas/ExpandedNodePanel';
import { SettingsPopover } from '../../components/Panels/Header/SettingsPopover';
import useCanvasStore from '../../store/canvasStore';
import { usePreviewStore } from '../../store/previewStore';

const SPLIT_MIN_PX = 200;
const SPLIT_DEFAULT_RATIO = 0.5;

/**
 * CenterArea renders the canvas and, when a node is expanded, either replaces
 * the canvas with the expanded panel or shows them side-by-side with a
 * draggable resize handle.
 */
type CenterAreaProps = {
  canvasShortcutsDisabled?: boolean;
  /**
   * Mirrors the chat (right) panel collapse state. Injected by MainLayout
   * so the floating chat-toggle button can live on top of the canvas
   * instead of as a vertical strip at the canvas edge.
   */
  isChatCollapsed?: boolean;
  onToggleChat?: () => void;
};

export const CenterArea: React.FC<CenterAreaProps> = ({
  canvasShortcutsDisabled = false,
  isChatCollapsed,
  onToggleChat,
}) => {
  const expandedNodeId = useCanvasStore((s) => s.expandedNodeId);
  const canvasExpandMode = useCanvasStore((s) => s.expandMode);

  const previewData = usePreviewStore((s) => s.previewData);
  const previewType = usePreviewStore((s) => s.previewType);
  const previewExpandMode = usePreviewStore((s) => s.expandMode);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const splitRatioRef = useRef(SPLIT_DEFAULT_RATIO);
  const [splitRatio, setSplitRatio] = React.useState(SPLIT_DEFAULT_RATIO);
  // Suspends width transition during drag so the split bar tracks the cursor.
  const [isResizing, setIsResizing] = React.useState(false);

  const hasPreview = !!previewData && !!previewType;
  const hasExpanded = !!expandedNodeId || hasPreview;

  // Determine effective expand mode based on what acts as the "expanded" content
  // Priority: Preview > Node Edit
  let isReplace = false;
  if (hasPreview) {
    isReplace = previewExpandMode === 'replace';
  } else if (expandedNodeId) {
    isReplace = canvasExpandMode === 'replace';
  }

  /* ---- Drag handle for split mode ---- */
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      setIsResizing(true);

      const startX = e.clientX;
      const startRatio = splitRatioRef.current;

      const onMove = (ev: PointerEvent) => {
        const container = containerRef.current;
        if (!container) return;
        const totalWidth = container.getBoundingClientRect().width;
        if (totalWidth <= 0) return;

        const dx = ev.clientX - startX;
        const deltaRatio = dx / totalWidth;
        const minRatio = SPLIT_MIN_PX / totalWidth;
        const maxRatio = 1 - minRatio;
        const next = Math.min(
          Math.max(startRatio + deltaRatio, minRatio),
          maxRatio,
        );
        splitRatioRef.current = next;
        setSplitRatio(next);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setIsResizing(false);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [],
  );

  // Always keep Canvas mounted in the same structural position to prevent
  // ReactFlow from unmounting/remounting (which would re-trigger fitView and
  // cause a visible "resize" whenever a node is expanded or a preview opens).
  const leftPercent = splitRatio * 100;

  // In replace mode the canvas is hidden but kept mounted.
  const canvasWidth = isReplace
    ? '0%'
    : hasExpanded
      ? `${leftPercent}%`
      : '100%';

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full overflow-hidden"
    >
      {/* Canvas – always mounted; width controlled via CSS. Hosts the
          floating top-right controls so they pin to the canvas's right
          edge (not the whole CenterArea) — in split mode the buttons
          stay over the canvas portion instead of bleeding into the
          expanded preview panel on the right. */}
      <div
        className="relative h-full shrink-0 overflow-hidden"
        data-animate-width
        data-resizing={isResizing ? 'true' : undefined}
        style={{ width: canvasWidth }}
      >
        <Canvas shortcutsDisabled={canvasShortcutsDisabled} />

        {/* Floating top-right controls — settings always visible; chat
            toggle is always visible and switches to an "active" solid
            style while the chat panel is expanded, so it doubles as the
            collapse control. All three buttons use the pill shape so
            they read as a uniform floating control group on top of the
            canvas. */}
        <div className="pointer-events-auto absolute top-3 right-2 z-30 flex items-center gap-1">
          {/* Handbook — opens the in-app user manual in a new browser
              tab so the canvas session stays intact while users
              reference the docs side-by-side. */}
          <Button
            variant="ghost"
            shape="pill"
            size="lg"
            iconOnly
            onClick={() => window.open('/docs', '_blank', 'noopener')}
            title="User Handbook"
            aria-label="Open user handbook"
          >
            <BookOpen />
          </Button>
          <SettingsPopover variant="ghost" shape="pill" size="lg" />
          {onToggleChat && (
            <Button
              variant="outline"
              shape="pill"
              iconOnly
              size="lg"
              onClick={onToggleChat}
              title={isChatCollapsed ? 'Open Chat' : 'Close Chat'}
              aria-label={
                isChatCollapsed ? 'Open chat panel' : 'Close chat panel'
              }
              aria-pressed={!isChatCollapsed}
              className={cn(
                // Active state mirrors the CanvasToolbar's active button —
                // icon switches to the theme info color over a soft
                // info-tinted background so the toggle reads as
                // "currently engaged" without the heavy solid look.
                !isChatCollapsed &&
                  'text-info bg-info-bg border-info-light enabled:hover:bg-info-bg-hover',
              )}
            >
              <Bot />
            </Button>
          )}
        </div>
      </div>

      {/* Resize handle – visible only in split mode */}
      {hasExpanded && !isReplace && (
        <div
          role="separator"
          aria-orientation="vertical"
          className="group flex w-2 shrink-0 cursor-col-resize items-center justify-center bg-transparent outline-none"
          onPointerDown={onHandlePointerDown}
        >
          <div className="bg-text-faded h-8 w-1 rounded-full opacity-0 transition-all duration-300 group-hover:h-12 group-hover:opacity-100" />
        </div>
      )}

      {/* Expanded panel – rendered only when needed. In replace mode we
          pin it above the canvas's floating popovers (which portal to
          body at z-index 1000) so canvas toolbars from the still-mounted
          underlying canvas can never leak through on top of the panel. */}
      {hasExpanded && (
        <div
          className={
            isReplace
              ? 'relative z-[1100] h-full w-full'
              : 'h-full min-w-0 flex-1'
          }
        >
          <ExpandedNodePanel
            isChatCollapsed={isChatCollapsed}
            onToggleChat={onToggleChat}
          />
        </div>
      )}
    </div>
  );
};
