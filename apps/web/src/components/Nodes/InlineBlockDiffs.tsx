import { clsx } from 'clsx';
import { diffWords } from 'diff';
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

/** A group of consecutive modified blocks. */
interface ModifiedRun {
  key: string;
  blockIds: string[];
}

/** A group of deleted blocks sharing the same afterBlockId. */
interface DeletedGroup {
  key: string; // afterBlockId or '__start__'
  items: Array<{ index: number; info: DeletedBlockInfo }>;
}

// ---------------------------------------------------------------------------
// Word-level diff (powered by the `diff` npm package)
// ---------------------------------------------------------------------------

export function computeWordDiff(
  oldText: string,
  newText: string,
): DiffSegment[] {
  if (oldText === newText) return [{ type: 'same', text: oldText }];
  if (!oldText) return [{ type: 'added', text: newText }];
  if (!newText) return [{ type: 'removed', text: oldText }];

  return diffWords(oldText, newText).map((change) => ({
    type: change.added ? 'added' : change.removed ? 'removed' : 'same',
    text: change.value,
  }));
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

/** Build groups of consecutive modified blocks from ordered block IDs.
 *  A deleted-block indicator between two modified blocks breaks the run. */
function buildModifiedRuns(
  orderedBlockIds: string[],
  blockDiffMap: Map<string, string>,
  deletedBlocks: DeletedBlockInfo[],
): ModifiedRun[] {
  // Collect block IDs that have a deletion indicator immediately after them.
  const hasDeleteAfter = new Set<string>();
  for (const info of deletedBlocks) {
    if (info.afterBlockId) hasDeleteAfter.add(info.afterBlockId);
  }

  const runs: ModifiedRun[] = [];
  let current: ModifiedRun | null = null;

  for (const blockId of orderedBlockIds) {
    if (blockDiffMap.has(blockId)) {
      if (!current) {
        current = { key: blockId, blockIds: [] };
      }
      current.blockIds.push(blockId);
      // Break the run if a deletion indicator follows this block.
      if (hasDeleteAfter.has(blockId) && current) {
        runs.push(current);
        current = null;
      }
    } else {
      if (current) {
        runs.push(current);
        current = null;
      }
    }
  }
  if (current) runs.push(current);

  return runs;
}

/** Build groups of deleted blocks, keyed by afterBlockId. */
function buildDeletedGroups(deletedBlocks: DeletedBlockInfo[]): DeletedGroup[] {
  const groupMap = new Map<
    string,
    Array<{ index: number; info: DeletedBlockInfo }>
  >();
  deletedBlocks.forEach((info, index) => {
    const key = info.afterBlockId ?? '__start__';
    const list = groupMap.get(key) ?? [];
    list.push({ index, info });
    groupMap.set(key, list);
  });

  const groups: DeletedGroup[] = [];
  for (const [key, items] of groupMap) {
    groups.push({ key, items });
  }
  return groups;
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
  orderedBlockIds: string[];
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

interface ModifiedRunPosition {
  run: ModifiedRun;
  top: number;
  right: number;
  width: number;
}

interface DeletedGroupPosition {
  group: DeletedGroup;
  top: number;
  right: number;
  width: number;
}

export const InlineBlockDiffs = ({
  blockDiffMap,
  deletedBlocks,
  orderedBlockIds,
  editorContainerRef,
  getBlockText,
  onAcceptBlock,
  onRejectBlock,
  onAcceptDeletedBlock,
  onRestoreBlock,
}: InlineBlockDiffsProps) => {
  // Hover state — separate for modified runs vs deleted groups
  const [hoveredModifiedKey, setHoveredModifiedKey] = useState<string | null>(
    null,
  );
  const hoveredModifiedKeyRef = useRef<string | null>(null);
  const [hoveredDeletedKey, setHoveredDeletedKey] = useState<string | null>(
    null,
  );
  const hideTimeoutRef = useRef(0);

  // Track scroll for recalculating positions
  const [scrollTick, setScrollTick] = useState(0);

  // Build groups
  const modifiedRuns = useMemo(
    () => buildModifiedRuns(orderedBlockIds, blockDiffMap, deletedBlocks),
    [orderedBlockIds, blockDiffMap, deletedBlocks],
  );

  const deletedGroups = useMemo(
    () => buildDeletedGroups(deletedBlocks),
    [deletedBlocks],
  );

  // Lookup: blockId → run key for quick hover resolution
  const blockIdToRunKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of modifiedRuns) {
      for (const blockId of run.blockIds) {
        map.set(blockId, run.key);
      }
    }
    return map;
  }, [modifiedRuns]);

  const scheduleHide = useCallback(() => {
    hideTimeoutRef.current = window.setTimeout(() => {
      hoveredModifiedKeyRef.current = null;
      setHoveredModifiedKey(null);
      setHoveredDeletedKey(null);
    }, 150);
  }, []);

  // Track hover via mousemove — trigger in the right-bar zone for modified runs
  useEffect(() => {
    const root = editorContainerRef.current;
    if (!root || (blockDiffMap.size === 0 && deletedBlocks.length === 0)) {
      setHoveredModifiedKey(null);
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest?.('[data-diff-popover]')) {
        clearTimeout(hideTimeoutRef.current);
        return;
      }

      const blockEl = target.closest?.('.bn-block[data-id]') as HTMLElement;
      if (!blockEl) {
        if (hoveredModifiedKeyRef.current) scheduleHide();
        return;
      }

      const blockId = blockEl.getAttribute('data-id');
      if (!blockId) {
        if (hoveredModifiedKeyRef.current) scheduleHide();
        return;
      }

      const runKey = blockIdToRunKey.get(blockId);
      if (!runKey) {
        if (hoveredModifiedKeyRef.current) scheduleHide();
        return;
      }

      const blockRect = blockEl.getBoundingClientRect();
      const dx = e.clientX - blockRect.right;
      if (dx < -4 || dx > BAR_OFFSET_RIGHT + 4) {
        if (hoveredModifiedKeyRef.current) scheduleHide();
        return;
      }

      clearTimeout(hideTimeoutRef.current);
      if (hoveredModifiedKeyRef.current === runKey) return;

      hoveredModifiedKeyRef.current = runKey;
      setHoveredModifiedKey(runKey);
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
  }, [
    blockDiffMap,
    deletedBlocks.length,
    blockIdToRunKey,
    editorContainerRef,
    scheduleHide,
  ]);

  // Scroll listener
  useEffect(() => {
    const root = editorContainerRef.current;
    if (!root || (modifiedRuns.length === 0 && deletedGroups.length === 0))
      return;

    const onScroll = () => setScrollTick((t) => t + 1);
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [editorContainerRef, modifiedRuns.length, deletedGroups.length]);

  const handlePopoverEnter = useCallback(() => {
    clearTimeout(hideTimeoutRef.current);
  }, []);

  const handlePopoverLeave = useCallback(() => {
    scheduleHide();
  }, [scheduleHide]);

  // Compute modified-run positions
  const [modifiedPositions, setModifiedPositions] = useState<
    ModifiedRunPosition[]
  >([]);

  useEffect(() => {
    if (modifiedRuns.length === 0) {
      setModifiedPositions([]);
      return;
    }
    const root = editorContainerRef.current;
    if (!root) return;

    const raf = requestAnimationFrame(() => {
      const containerRect = root.getBoundingClientRect();
      const positions: ModifiedRunPosition[] = [];

      for (const run of modifiedRuns) {
        // Use the first block in the run for popover position (top-aligned)
        const firstId = run.blockIds[0];
        const escapedId = CSS.escape(firstId);
        const blockEl = root.querySelector<HTMLElement>(
          `.bn-block[data-id="${escapedId}"]`,
        );
        if (!blockEl) continue;

        const rect = blockEl.getBoundingClientRect();
        positions.push({
          run,
          top: Math.round(rect.top - containerRect.top + root.scrollTop),
          right: Math.round(rect.right - containerRect.left + root.scrollLeft),
          width: Math.round(rect.width),
        });
      }

      setModifiedPositions(positions);
    });

    return () => cancelAnimationFrame(raf);
  }, [modifiedRuns, editorContainerRef, scrollTick]);

  // Compute deleted-group positions
  const [deletedPositions, setDeletedPositions] = useState<
    DeletedGroupPosition[]
  >([]);

  useEffect(() => {
    if (deletedGroups.length === 0) {
      setDeletedPositions([]);
      return;
    }
    const root = editorContainerRef.current;
    if (!root) return;

    const raf = requestAnimationFrame(() => {
      const containerRect = root.getBoundingClientRect();
      const positions: DeletedGroupPosition[] = [];

      for (const group of deletedGroups) {
        let anchorBottom: number;
        let anchorRight: number;
        let anchorWidth: number;

        if (group.key !== '__start__') {
          const escapedId = CSS.escape(group.key);
          let blockEl = root.querySelector<HTMLElement>(
            `.bn-block[data-id="${escapedId}"]`,
          );
          if (!blockEl) {
            // Fallback: anchor block no longer in DOM — use the last block
            const allBlocks =
              root.querySelectorAll<HTMLElement>('.bn-block[data-id]');
            blockEl =
              allBlocks.length > 0 ? allBlocks[allBlocks.length - 1] : null;
            if (!blockEl) continue;
          }

          const rect = blockEl.getBoundingClientRect();
          anchorBottom = rect.bottom - containerRect.top + root.scrollTop;
          anchorRight = rect.right - containerRect.left + root.scrollLeft;
          anchorWidth = rect.width;
        } else {
          anchorBottom = 0;
          anchorRight = containerRect.width;
          anchorWidth = containerRect.width;
        }

        positions.push({
          group,
          top: anchorBottom,
          right: anchorRight,
          width: anchorWidth,
        });
      }

      setDeletedPositions(positions);
    });

    return () => cancelAnimationFrame(raf);
  }, [deletedGroups, editorContainerRef, blockDiffMap, scrollTick]);

  // Find hovered positions
  const hoveredModifiedPos = hoveredModifiedKey
    ? modifiedPositions.find((p) => p.run.key === hoveredModifiedKey)
    : null;

  const hoveredDeletedPos = hoveredDeletedKey
    ? deletedPositions.find((p) => p.group.key === hoveredDeletedKey)
    : null;

  return (
    <>
      {/* Modified block run popover */}
      {hoveredModifiedPos && (
        <DiffPopover
          style={{
            top: hoveredModifiedPos.top,
            left: hoveredModifiedPos.right + BAR_OFFSET_RIGHT,
            width: hoveredModifiedPos.width,
            transform: 'translateX(-100%)',
          }}
          onReject={() => {
            for (const blockId of hoveredModifiedPos.run.blockIds) {
              onRejectBlock(blockId);
            }
            hoveredModifiedKeyRef.current = null;
            setHoveredModifiedKey(null);
          }}
          onAccept={() => {
            for (const blockId of hoveredModifiedPos.run.blockIds) {
              onAcceptBlock(blockId);
            }
            hoveredModifiedKeyRef.current = null;
            setHoveredModifiedKey(null);
          }}
          onMouseEnter={handlePopoverEnter}
          onMouseLeave={handlePopoverLeave}
        >
          {hoveredModifiedPos.run.blockIds.map((blockId, i) => {
            const oldRunText = blockDiffMap.get(blockId) ?? '';
            const newRunText = getBlockText(blockId);
            const segments = computeWordDiff(oldRunText, newRunText);

            return (
              <div key={blockId} className={i > 0 ? 'mt-1 pt-1' : ''}>
                {segments.map((seg, si) => (
                  <span
                    key={si}
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
              </div>
            );
          })}
        </DiffPopover>
      )}

      {/* Deleted block group indicators (red markers) + popovers */}
      {deletedPositions.map((pos) => (
        <div key={`del-group-${pos.group.key}`}>
          {/* Invisible hit-area div — tall and wide enough to hover easily */}
          <div
            className="absolute z-5 flex cursor-pointer items-center justify-center"
            style={{
              top: pos.top - 8,
              left: pos.right + BAR_OFFSET_RIGHT - 6,
              width: 18,
              height: 16,
            }}
            onMouseEnter={() => {
              clearTimeout(hideTimeoutRef.current);
              setHoveredDeletedKey(pos.group.key);
            }}
            onMouseLeave={() => {
              setHoveredDeletedKey(null);
            }}
          >
            {/* Visible red marker — 6px wide line matching the bar width */}
            <div
              style={{
                width: 6,
                height: 6,
                backgroundColor:
                  hoveredDeletedKey === pos.group.key ? '#ef4444' : '#f87171',
                borderRadius: 1,
                transition: 'background-color 150ms',
              }}
            />
          </div>

          {hoveredDeletedPos?.group.key === pos.group.key && (
            <DiffPopover
              style={{
                top: pos.top - 8,
                left: pos.right + BAR_OFFSET_RIGHT,
                width: pos.width,
                transform: 'translateX(-100%)',
              }}
              onReject={() => {
                const indices = pos.group.items
                  .map((item) => item.index)
                  .sort((a, b) => b - a);
                for (const idx of indices) {
                  onRestoreBlock(idx);
                }
                setHoveredDeletedKey(null);
              }}
              onAccept={() => {
                const indices = pos.group.items
                  .map((item) => item.index)
                  .sort((a, b) => b - a);
                for (const idx of indices) {
                  onAcceptDeletedBlock(idx);
                }
                setHoveredDeletedKey(null);
              }}
              onMouseEnter={() => {
                clearTimeout(hideTimeoutRef.current);
                setHoveredDeletedKey(pos.group.key);
              }}
              onMouseLeave={() => setHoveredDeletedKey(null)}
            >
              {pos.group.items.map((item, i) => (
                <div
                  key={item.index}
                  className={clsx(
                    'bg-red-100 text-red-600 line-through',
                    i > 0 && 'mt-1 border-t border-red-200 pt-1',
                  )}
                >
                  {item.info.text}
                </div>
              ))}
            </DiffPopover>
          )}
        </div>
      ))}
    </>
  );
};
