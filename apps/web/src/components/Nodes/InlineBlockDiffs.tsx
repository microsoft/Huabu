import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/Common/Button';

import type { DeletedBlockInfo } from '@/utils/provenance';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiffSegment {
  type: 'same' | 'added' | 'removed';
  text: string;
}

// ---------------------------------------------------------------------------
// Word-level diff
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text.match(/\S+|\s+/g) || [];
}

export function computeWordDiff(
  oldText: string,
  newText: string,
): DiffSegment[] {
  if (oldText === newText) return [{ type: 'same', text: oldText }];
  if (!oldText) return [{ type: 'added', text: newText }];
  if (!newText) return [{ type: 'removed', text: oldText }];

  const a = tokenize(oldText);
  const b = tokenize(newText);
  const m = a.length;
  const n = b.length;

  // LCS DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack
  const stack: DiffSegment[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      stack.push({ type: 'same', text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'added', text: b[j - 1] });
      j--;
    } else {
      stack.push({ type: 'removed', text: a[i - 1] });
      i--;
    }
  }
  stack.reverse();

  // Merge consecutive segments of the same type
  const segments: DiffSegment[] = [];
  for (const seg of stack) {
    const last = segments[segments.length - 1];
    if (last && last.type === seg.type) {
      last.text += seg.text;
    } else {
      segments.push({ ...seg });
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Shared diff popover
// ---------------------------------------------------------------------------

interface DiffPopoverProps {
  style: React.CSSProperties;
  children: React.ReactNode;
  onAccept: () => void;
  onReject: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

const DiffPopover = ({
  style,
  children,
  onAccept,
  onReject,
  onMouseEnter,
  onMouseLeave,
}: DiffPopoverProps) => (
  <div
    data-diff-popover
    className="absolute z-10 max-h-100 overflow-y-auto rounded-md border border-gray-200 bg-white p-3 shadow-lg"
    style={style}
    onMouseEnter={onMouseEnter}
    onMouseLeave={onMouseLeave}
  >
    <div className="mb-2 text-xs leading-relaxed">{children}</div>
    <div className="flex justify-end gap-1">
      <Button variant="secondary" size="sm" onClick={onReject}>
        Reject
      </Button>
      <Button variant="primary" size="sm" onClick={onAccept}>
        Accept
      </Button>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface InlineBlockDiffsProps {
  blockDiffMap: Map<string, string>;
  deletedBlocks: DeletedBlockInfo[];
  editorContainerRef: React.RefObject<HTMLElement | null>;
  getBlockText: (blockId: string) => string;
  onAcceptBlock: (blockId: string) => void;
  onRejectBlock: (blockId: string) => void;
  onAcceptDeletedBlock: (index: number) => void;
  onRestoreBlock: (index: number) => void;
}

/** The bar (::before) is positioned at right: -12px, width: 6px.
 *  Bar spans blockRight+6 → blockRight+12 in screen coords. */
const BAR_OFFSET_RIGHT = 6;

export const InlineBlockDiffs = ({
  blockDiffMap,
  deletedBlocks,
  editorContainerRef,
  getBlockText,
  onAcceptBlock,
  onRejectBlock,
  onAcceptDeletedBlock,
  onRestoreBlock,
}: InlineBlockDiffsProps) => {
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  const hoveredBlockIdRef = useRef<string | null>(null);
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const hideTimeoutRef = useRef(0);

  const [hoveredDeletedIdx, setHoveredDeletedIdx] = useState<number | null>(
    null,
  );

  // Track scroll for recalculating deleted indicator positions
  const [scrollTick, setScrollTick] = useState(0);

  const scheduleHide = useCallback(() => {
    hideTimeoutRef.current = window.setTimeout(() => {
      hoveredBlockIdRef.current = null;
      setHoveredBlockId(null);
      setPopoverPos(null);
    }, 150);
  }, []);

  // Track hover via mousemove — only trigger in the right-bar zone
  useEffect(() => {
    const root = editorContainerRef.current;
    if (!root || (blockDiffMap.size === 0 && deletedBlocks.length === 0)) {
      setHoveredBlockId(null);
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      // Ignore if hovering the popover itself
      const target = e.target as HTMLElement;
      if (target.closest?.('[data-diff-popover]')) {
        clearTimeout(hideTimeoutRef.current);
        return;
      }

      const blockEl = target.closest?.('.bn-block[data-id]') as HTMLElement;
      if (!blockEl) {
        if (hoveredBlockIdRef.current) scheduleHide();
        return;
      }

      const blockId = blockEl.getAttribute('data-id');
      if (!blockId || !blockDiffMap.has(blockId)) {
        if (hoveredBlockIdRef.current) scheduleHide();
        return;
      }

      // Only trigger when near the bar zone (bar is 7–12px right of block edge)
      const blockRect = blockEl.getBoundingClientRect();
      const dx = e.clientX - blockRect.right;
      // Hit zone: from a few px left of bar to a few px right of bar
      if (dx < -4 || dx > BAR_OFFSET_RIGHT + 4) {
        if (hoveredBlockIdRef.current === blockId) scheduleHide();
        return;
      }

      clearTimeout(hideTimeoutRef.current);

      if (hoveredBlockIdRef.current === blockId) return; // already showing

      const containerRect = root.getBoundingClientRect();

      hoveredBlockIdRef.current = blockId;
      setHoveredBlockId(blockId);
      setPopoverPos({
        top: Math.round(blockRect.top - containerRect.top + root.scrollTop),
        left: Math.round(
          blockRect.right - containerRect.left + root.scrollLeft,
        ),
        width: Math.round(blockRect.width),
      });
    };

    const handleMouseLeave = () => {
      scheduleHide();
    };

    root.addEventListener('mousemove', handleMouseMove);
    root.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      root.removeEventListener('mousemove', handleMouseMove);
      root.removeEventListener('mouseleave', handleMouseLeave);
      clearTimeout(hideTimeoutRef.current);
    };
  }, [blockDiffMap, deletedBlocks.length, editorContainerRef, scheduleHide]);

  // Scroll listener for recalculating deleted indicator positions
  useEffect(() => {
    const root = editorContainerRef.current;
    if (!root || deletedBlocks.length === 0) return;

    const onScroll = () => setScrollTick((t) => t + 1);
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [editorContainerRef, deletedBlocks.length]);

  const handlePopoverEnter = useCallback(() => {
    clearTimeout(hideTimeoutRef.current);
  }, []);

  const handlePopoverLeave = useCallback(() => {
    scheduleHide();
  }, [scheduleHide]);

  // Word diff for hovered modified block
  const oldText = hoveredBlockId
    ? (blockDiffMap.get(hoveredBlockId) ?? '')
    : '';
  const newText = hoveredBlockId ? getBlockText(hoveredBlockId) : '';
  const diffSegments = useMemo(
    () => (hoveredBlockId ? computeWordDiff(oldText, newText) : []),
    [hoveredBlockId, oldText, newText],
  );

  // Deleted block indicator positions (computed from DOM after layout)
  const [deletedIndicatorPositions, setDeletedIndicatorPositions] = useState<
    Array<{
      index: number;
      info: DeletedBlockInfo;
      top: number;
      right: number;
      width: number;
    }>
  >([]);

  useEffect(() => {
    if (deletedBlocks.length === 0) {
      setDeletedIndicatorPositions([]);
      return;
    }
    const root = editorContainerRef.current;
    if (!root) return;

    // Use requestAnimationFrame to ensure DOM has settled after banner reflow
    const raf = requestAnimationFrame(() => {
      const containerRect = root.getBoundingClientRect();

      const positions = deletedBlocks
        .map((info, index) => {
          let anchorBottom: number;
          let anchorRight: number;
          let anchorWidth: number;

          if (info.afterBlockId) {
            const escapedId = CSS.escape(info.afterBlockId);
            // Use bn-block to get the element with the purple ::before bar
            const blockEl = root.querySelector<HTMLElement>(
              `.bn-block[data-id="${escapedId}"]`,
            );
            if (!blockEl) return null;

            const rect = blockEl.getBoundingClientRect();
            anchorBottom = rect.bottom - containerRect.top + root.scrollTop;
            anchorRight = rect.right - containerRect.left + root.scrollLeft;
            anchorWidth = rect.width;
          } else {
            anchorBottom = 0;
            anchorRight = containerRect.width;
            anchorWidth = containerRect.width;
          }

          return {
            index,
            info,
            top: anchorBottom,
            right: anchorRight,
            width: anchorWidth,
          };
        })
        .filter(Boolean) as Array<{
        index: number;
        info: DeletedBlockInfo;
        top: number;
        right: number;
        width: number;
      }>;

      setDeletedIndicatorPositions(positions);
    });

    return () => cancelAnimationFrame(raf);
  }, [deletedBlocks, editorContainerRef, blockDiffMap, scrollTick]);

  const showModifiedPopover =
    hoveredBlockId && popoverPos && diffSegments.length > 0;

  return (
    <>
      {/* Modified block diff popover */}
      {showModifiedPopover && (
        <DiffPopover
          style={{
            top: popoverPos.top,
            left: popoverPos.left + BAR_OFFSET_RIGHT,
            width: popoverPos.width,
            transform: 'translateX(-100%)',
          }}
          onReject={() => {
            onRejectBlock(hoveredBlockId);
            setHoveredBlockId(null);
            hoveredBlockIdRef.current = null;
          }}
          onAccept={() => {
            onAcceptBlock(hoveredBlockId);
            setHoveredBlockId(null);
            hoveredBlockIdRef.current = null;
          }}
          onMouseEnter={handlePopoverEnter}
          onMouseLeave={handlePopoverLeave}
        >
          {diffSegments.map((seg, i) => (
            <span
              key={i}
              className={
                seg.type === 'removed'
                  ? 'bg-red-100 text-red-600 line-through'
                  : seg.type === 'added'
                    ? 'bg-green-100 text-green-700'
                    : 'text-gray-600'
              }
            >
              {seg.text}
            </span>
          ))}
        </DiffPopover>
      )}

      {/* Deleted block indicators */}
      {deletedIndicatorPositions.map((pos) => (
        <div key={`del-${pos.index}`}>
          {/* Red dot on the purple bar at deletion point */}
          <div
            className="absolute z-[5] cursor-pointer"
            style={{
              top: pos.top - 1,
              left: pos.right + BAR_OFFSET_RIGHT,
              width: 6,
              height: 6,
              backgroundColor: '#f87171',
              transition: 'background-color 150ms',
            }}
            onMouseEnter={(e) => {
              clearTimeout(hideTimeoutRef.current);
              (e.currentTarget as HTMLElement).style.backgroundColor =
                '#ef4444';
              setHoveredDeletedIdx(pos.index);
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor =
                '#f87171';
              setHoveredDeletedIdx(null);
            }}
          />

          {/* Popover for hovered deleted block */}
          {hoveredDeletedIdx === pos.index && (
            <DiffPopover
              style={{
                top: pos.top - 8,
                left: pos.right + BAR_OFFSET_RIGHT,
                width: pos.width,
                transform: 'translateX(-100%)',
              }}
              onReject={() => {
                onRestoreBlock(pos.index);
                setHoveredDeletedIdx(null);
              }}
              onAccept={() => {
                onAcceptDeletedBlock(pos.index);
                setHoveredDeletedIdx(null);
              }}
              onMouseEnter={() => {
                clearTimeout(hideTimeoutRef.current);
                setHoveredDeletedIdx(pos.index);
              }}
              onMouseLeave={() => setHoveredDeletedIdx(null)}
            >
              <span className="bg-red-100 text-red-600 line-through">
                {pos.info.text}
              </span>
            </DiffPopover>
          )}
        </div>
      ))}
    </>
  );
};
