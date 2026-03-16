import { Loader2, PenLine, Send, X } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useIntentStore } from '../../store/intentStore';
import { Button } from '../Common/Button';
import { IconButton } from '../Common/IconButton';

// ---------------------------------------------------------------------------
// Step 1: Intent Selection (hover to preview, click to select)
// ---------------------------------------------------------------------------

const IntentSelectStep: React.FC<{ anchorY: number }> = ({ anchorY }) => {
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
        <div className="text-muted-foreground px-3 py-4 text-sm">
          No suggestions available.
        </div>
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
                <button
                  type="button"
                  className={`mx-2 flex w-[calc(100%-16px)] cursor-pointer flex-col rounded-md px-2 py-1.5 text-left transition-colors ${
                    isSelected ? 'bg-theme-100' : isHovered ? 'bg-muted' : ''
                  }`}
                  onMouseEnter={() => setHoveredIdx(idx)}
                  onMouseLeave={() => setHoveredIdx(null)}
                  onClick={() => selectCandidate(idx)}
                >
                  {/* Description above label when expanding up */}
                  {isHovered && expandUp && c.description && (
                    <span className="text-muted-foreground mb-0.5 text-xs leading-snug">
                      {c.description}
                    </span>
                  )}
                  <span className="text-foreground text-sm">{c.label}</span>
                  {/* Description below label when expanding down */}
                  {isHovered && !expandUp && c.description && (
                    <span className="text-muted-foreground mt-0.5 text-xs leading-snug">
                      {c.description}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
          {isStreaming && (
            <li className="text-muted-foreground flex items-center gap-1.5 px-4 py-1.5 text-xs">
              <Loader2 size={12} className="animate-spin" />
              <span>Thinking…</span>
            </li>
          )}
        </ul>
      )}

      {/* Custom intent input */}
      <div className="border-border border-t px-3 py-2">
        <div className="flex items-center gap-1.5">
          <PenLine
            size={12}
            className="text-muted-foreground/60 flex-shrink-0"
          />
          <input
            ref={inputRef}
            type="text"
            placeholder="Describe your intent…"
            className="text-foreground placeholder:text-muted-foreground/50 w-full bg-transparent text-sm outline-none"
            value={customIntent}
            onChange={(e) => setCustomIntent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCustomSubmit();
            }}
          />
          <IconButton
            type="button"
            title="Send"
            className="text-muted-foreground hover:text-theme-500 flex-shrink-0 transition-colors disabled:opacity-30"
            disabled={!customIntent.trim()}
            onClick={handleCustomSubmit}
          >
            <Send size={14} />
          </IconButton>
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
      className="border-border fixed w-80 cursor-grab rounded-md border bg-white shadow active:cursor-grabbing"
      style={posStyle}
      onPointerDown={handlePointerDown}
    >
      {/* Title bar */}
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        <span className="text-foreground/80 min-w-0 flex-1 truncate text-sm">
          Intent Recognition
        </span>
        <IconButton
          title="Close"
          className="text-muted-foreground hover:text-foreground flex-shrink-0 rounded p-0.5"
          onClick={dismiss}
        >
          <X size={14} />
        </IconButton>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 px-3 py-4 text-sm">
          <Loader2 size={16} className="animate-spin" />
          <span>Analyzing context…</span>
        </div>
      ) : (
        <IntentSelectStep anchorY={position.y} />
      )}
    </div>,
    document.body,
  );
};
