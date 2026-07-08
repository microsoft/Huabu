import { PenLine, Send, X } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { EmptyState } from '@/components/Common/EmptyState';
import { Loading } from '@/components/Common/Loading';
import { useIntentStore } from '@/store/intentStore';

// ---------------------------------------------------------------------------
// Step 1: Intent Selection (hover to preview, click to select)
// ---------------------------------------------------------------------------

const IntentSelectStep: React.FC<{ anchorY: number }> = ({ anchorY }) => {
  const { t } = useTranslation();
  const candidates = useIntentStore((s) => s.candidates);
  const selectedIndex = useIntentStore((s) => s.selectedIndex);
  const customIntent = useIntentStore((s) => s.customIntent);
  const isStreaming = useIntentStore((s) => s.isStreaming);
  const selectCandidate = useIntentStore((s) => s.selectCandidate);
  const submitCustomIntent = useIntentStore((s) => s.submitCustomIntent);
  const setCustomIntent = useIntentStore((s) => s.setCustomIntent);

  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const itemRefs = useRef<Map<number, HTMLLIElement>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);

  // Determine whether description should expand upward or downward
  // based on the item's position relative to viewport center and anchor.
  const shouldExpandUp = useCallback(
    (idx: number): boolean => {
      const el = itemRefs.current.get(idx);
      if (!el) return anchorY > window.innerHeight / 2;
      const rect = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      return spaceBelow < 60;
    },
    [anchorY],
  );

  const handleCustomSubmit = useCallback(() => {
    if (customIntent.trim()) {
      submitCustomIntent(customIntent.trim());
    }
  }, [customIntent, submitCustomIntent]);

  return (
    <div className="flex flex-col">
      {candidates.length === 0 && !isStreaming ? (
        <EmptyState message={t('intent.noSuggestions')} className="px-3 py-4" />
      ) : (
        <ul className="my-1 flex flex-col">
          {candidates.map((c, idx) => {
            const isSelected = selectedIndex === idx;
            const isHovered = hoveredIdx === idx;
            const expandUp = isHovered && shouldExpandUp(idx);

            return (
              <li
                key={idx}
                ref={(el) => {
                  if (el) itemRefs.current.set(idx, el);
                  else itemRefs.current.delete(idx);
                }}
                className="relative"
              >
                <Button
                  variant="ghost"
                  className={`mx-2 flex w-[calc(100%-16px)] cursor-pointer flex-col rounded-md px-2 py-1.5 text-left transition-colors ${
                    isSelected ? 'bg-info-bg' : isHovered ? 'bg-bg-default' : ''
                  }`}
                  onMouseEnter={() => setHoveredIdx(idx)}
                  onMouseLeave={() => setHoveredIdx(null)}
                  onClick={() => selectCandidate(idx)}
                >
                  {/* Description above label when expanding up */}
                  {isHovered && expandUp && c.description && (
                    <span className="text-fg-muted mb-0.5 text-xs leading-snug">
                      {c.description}
                    </span>
                  )}
                  <span className="text-fg-default text-sm">{c.label}</span>
                  {/* Description below label when expanding down */}
                  {isHovered && !expandUp && c.description && (
                    <span className="text-fg-muted mt-0.5 text-xs leading-snug">
                      {c.description}
                    </span>
                  )}
                </Button>
              </li>
            );
          })}
          {isStreaming && (
            <li className="text-fg-subtle flex items-center gap-1.5 px-4 py-1.5 text-xs">
              <Loading layout="inline" size="xs" />
              <span>{t('messages.thinking')}</span>
            </li>
          )}
        </ul>
      )}

      {/* Custom intent input */}
      <div className="border-edge-default border-t px-3 py-2">
        <div className="flex items-center gap-1.5">
          <PenLine size={12} className="text-fg-muted/60 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder={t('intent.placeholder')}
            className="text-fg-default placeholder:text-fg-subtle/50 w-full bg-transparent text-sm outline-none"
            value={customIntent}
            onChange={(e) => setCustomIntent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCustomSubmit();
            }}
          />
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            type="button"
            title={t('chat.send')}
            disabled={!customIntent.trim()}
            onClick={handleCustomSubmit}
          >
            <Send />
          </Button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// IntentPopover (main)
//
// Positioning: anchored by BOTTOM edge via CSS `bottom`. Content grows
// upward — no jitter. maxHeight prevents overflow above viewport.
// ---------------------------------------------------------------------------

const POPOVER_WIDTH = 320;
const MARGIN = 12;
const GAP = 12;

export const IntentPopover: React.FC = () => {
  const { t } = useTranslation();
  const isOpen = useIntentStore((s) => s.isOpen);
  const isLoading = useIntentStore((s) => s.isLoading);
  const position = useIntentStore((s) => s.position);
  const dismiss = useIntentStore((s) => s.dismiss);

  const containerRef = useRef<HTMLDivElement>(null);
  const [xPos, setXPos] = useState(0);
  const [bottomAnchor, setBottomAnchor] = useState<number | null>(null);
  const [ready, setReady] = useState(false);

  // Drag state
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    mx: number;
    my: number;
    ox: number;
    oy: number;
  } | null>(null);

  // Track previous position to detect reopens
  const prevPosRef = useRef<{ x: number; y: number } | null>(null);

  // Compute anchor position. Runs synchronously after render.
  useLayoutEffect(() => {
    if (!isOpen || !position) {
      prevPosRef.current = null;
      return;
    }

    // Reset drag when position changes
    const prev = prevPosRef.current;
    if (!prev || prev.x !== position.x || prev.y !== position.y) {
      setDragPos(null);
    }
    prevPosRef.current = position;

    const rawX = position.x - POPOVER_WIDTH / 2;
    setXPos(
      Math.max(
        MARGIN,
        Math.min(rawX, window.innerWidth - POPOVER_WIDTH - MARGIN),
      ),
    );
    setBottomAnchor(window.innerHeight - position.y + GAP);
    setReady(true);
  }, [isOpen, position]);

  // Hide when closed
  useEffect(() => {
    if (!isOpen) {
      setReady(false);
      setBottomAnchor(null);
    }
  }, [isOpen]);

  // Escape to dismiss
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, dismiss]);

  // Drag handler — reads current rect at drag start so no stale closure issues
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const tag = (e.target as HTMLElement).closest(
      'button, input, textarea, select, [role="button"]',
    );
    if (tag) return;
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      mx: e.clientX,
      my: e.clientY,
      ox: rect.left,
      oy: rect.top,
    };

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      setDragPos({
        x: dragRef.current.ox + ev.clientX - dragRef.current.mx,
        y: dragRef.current.oy + ev.clientY - dragRef.current.my,
      });
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, []);

  if (!isOpen || !position) return null;

  // When dragging, use absolute top/left. Otherwise use CSS bottom to
  // anchor the popover's bottom edge — grows upward, no jitter.
  const posStyle: React.CSSProperties = dragPos
    ? { left: dragPos.x, top: dragPos.y, visibility: 'visible', zIndex: 9999 }
    : {
        left: xPos,
        bottom: bottomAnchor ?? 0,
        maxHeight: ready
          ? `calc(100vh - ${(bottomAnchor ?? 0) + MARGIN}px)`
          : undefined,
        overflowY: 'auto',
        visibility: ready ? 'visible' : 'hidden',
        zIndex: 9999,
      };

  return createPortal(
    <div
      ref={containerRef}
      className="border-edge-default bg-surface fixed w-80 cursor-grab rounded-md border shadow active:cursor-grabbing"
      style={posStyle}
      onPointerDown={handlePointerDown}
    >
      {/* Title bar */}
      <div className="border-edge-default flex items-center gap-2 border-b px-3 py-2">
        <span className="text-fg-default/80 min-w-0 flex-1 truncate text-sm">
          Intent Recognition
        </span>
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          title={t('actions.close')}
          onClick={dismiss}
        >
          <X />
        </Button>
      </div>

      {isLoading ? (
        <div className="text-fg-subtle flex items-center gap-2 px-3 py-4 text-sm">
          <Loading layout="inline" size="sm" />
          <span>{t('intent.analyzingContext')}</span>
        </div>
      ) : (
        <IntentSelectStep anchorY={position.y} />
      )}
    </div>,
    document.body,
  );
};
