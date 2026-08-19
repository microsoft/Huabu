// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Provenance overlay (Phase 4) — hover-triggered word-level diff
 * popover for AI-edited blocks AND tombstone markers for AI-deleted
 * blocks.
 *
 * Visual contract (matches the pre-Milkdown experience):
 *
 *  • Edited block: a thin info-coloured accent bar sits in the
 *    editor's right gutter (`::after` on `.huabu-ai-edited-block`,
 *    declared in `milkdown-overrides.css`). Hovering near the bar
 *    reveals a popover anchored to the block's right edge
 *    that renders a word-level diff between the AI-overwritten
 *    `baselineMarkdown` and the live block markdown, with `Accept`
 *    and `Reject` buttons.
 *
 *  • Deleted block: a thin danger-coloured accent bar straddles the
 *    boundary just below the surviving anchor block, in the same
 *    gutter column as the edit bar so the three provenance states
 *    visually belong to one family. Hovering it reveals a popover
 *    with the strike-through deleted text and `Reject` (restore) /
 *    `Accept` (dismiss) buttons.
 *
 * The overlay is absolutely positioned inside `containerRef` (the
 * NotePreview scroll wrapper) and re-measured on editor mutations,
 * scroll, and resize.
 */

import { diffArrays, diffWords } from 'diff';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { topLevelListItemMarkdown } from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';

import type { MilkdownInstance } from '@/components/Milkdown';
import type { BlockProvenance, DeletedBlockInfo } from '@huabu/shared';

export interface ProvenanceOverlayProps {
  blocks: ReadonlyArray<BlockProvenance>;
  tombstones: ReadonlyArray<DeletedBlockInfo>;
  editor: MilkdownInstance | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onAcceptBlock: (key: string) => void;
  onRejectBlock: (key: string) => void;
  /**
   * Optional. When provided, the per-block popover renders an extra
   * "Insert Below" button that restores the original baseline AND
   * keeps the AI rewrite as a new block underneath. Drops the
   * provenance marker for the affected key.
   */
  onInsertBelow?: (key: string, baselineMarkdown: string) => void;
  onRestoreTombstone: (
    deletedKey: string,
    markdown: string,
    anchorKey: string | null,
  ) => void;
  onDismissTombstone: (deletedKey: string) => void;
}

interface BlockSlot {
  kind: 'block';
  entry: BlockProvenance;
  /** Top in container-relative coordinates (px). */
  top: number;
  /** Right in container-relative coordinates (px) — block's right edge. */
  right: number;
  /** Block width (px). */
  width: number;
  /** Block height (px). */
  height: number;
}
interface TombSlot {
  kind: 'tomb';
  /** Anchor key shared by every entry in `entries` (`null` = doc head). */
  anchorKey: string | null;
  /** All deleted entries grouped at this anchor, in original order. */
  entries: ReadonlyArray<DeletedBlockInfo>;
  /** Top of the marker (sits just below the anchor). */
  top: number;
  /** Right edge of the anchor block. */
  right: number;
  /** Width of the anchor block (used to size the popover). */
  width: number;
}
type Slot = BlockSlot | TombSlot;

interface DiffSegment {
  type: 'same' | 'added' | 'removed';
  text: string;
}

function computeWordDiff(oldText: string, newText: string): DiffSegment[] {
  if (oldText === newText) return [{ type: 'same', text: oldText }];
  if (!oldText) return [{ type: 'added', text: newText }];
  if (!newText) return [{ type: 'removed', text: oldText }];
  return diffWords(oldText, newText).map((change) => ({
    type: change.added ? 'added' : change.removed ? 'removed' : 'same',
    text: change.value,
  }));
}

export function computeDisplayDiffs(
  oldText: string,
  newText: string,
): DiffSegment[][] {
  const oldItems = topLevelListItemMarkdown(oldText);
  const newItems = topLevelListItemMarkdown(newText);
  if (!oldItems || !newItems) return [computeWordDiff(oldText, newText)];

  return diffArrays(oldItems, newItems).flatMap((change) => {
    if (change.added) {
      return change.value.map((item) => computeWordDiff('', item));
    }
    if (change.removed) {
      return change.value.map((item) => computeWordDiff(item, ''));
    }
    return change.value.map((item) => computeWordDiff(item, item));
  });
}

/** Pixel offset of the gutter bar from the block's right edge. */
const GUTTER_OFFSET = 12;
const GUTTER_HIT_LEFT = 3;
const GUTTER_HIT_WIDTH = 12;

export function isPointInEditedBlockGutter(
  x: number,
  y: number,
  slot: Pick<BlockSlot, 'top' | 'right' | 'height'>,
): boolean {
  return (
    y >= slot.top &&
    y <= slot.top + slot.height &&
    x >= slot.right + GUTTER_HIT_LEFT &&
    x <= slot.right + GUTTER_HIT_LEFT + GUTTER_HIT_WIDTH
  );
}

export function ProvenanceOverlay({
  blocks,
  tombstones,
  editor,
  containerRef,
  onAcceptBlock,
  onRejectBlock,
  onInsertBelow,
  onRestoreTombstone,
  onDismissTombstone,
}: ProvenanceOverlayProps): React.JSX.Element | null {
  const [slots, setSlots] = useState<Slot[]>([]);
  // Tomb groups are identified by their shared anchorKey (`__head__`
  // for the null-anchor doc-head group). Block hover keeps using the
  // entry's fingerprint key.
  const [hovered, setHovered] = useState<{
    kind: 'block' | 'tomb';
    key: string;
  } | null>(null);
  const hideTimerRef = useRef<number>(0);

  const sig = useMemo(() => {
    const b = blocks.map((x) => `${x.key}@${x.at}`).join(',');
    const t = tombstones
      .map((x) => `${x.key}@${x.at}@${x.anchorKey ?? '_'}`)
      .join(',');
    return `${b}|${t}`;
  }, [blocks, tombstones]);

  const recomputeRef = useRef<() => void>(() => {});
  recomputeRef.current = () => {
    const container = containerRef.current;
    if (!editor || !container) {
      setSlots([]);
      return;
    }
    const cRect = container.getBoundingClientRect();
    const next: Slot[] = [];

    // One traversal feeds every per-key DOM lookup below; without
    // this each `getBlockDOMByKey` would re-fingerprint the doc.
    const snap = editor.snapshotBlocks();

    for (const entry of blocks) {
      const dom = snap.getDOM(entry.key);
      if (!dom) continue;
      const rect = dom.getBoundingClientRect();
      next.push({
        kind: 'block',
        entry,
        top: rect.top - cRect.top + container.scrollTop,
        right: rect.right - cRect.left + container.scrollLeft,
        width: rect.width,
        height: rect.height,
      });
    }

    // Group adjacent tombstones by their shared anchorKey so multiple
    // consecutive deletes show a single marker / popover (matching the
    // pre-Milkdown experience).
    const groups = new Map<string | null, DeletedBlockInfo[]>();
    for (const entry of tombstones) {
      const key = entry.anchorKey;
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
    for (const [anchorKey, entries] of groups) {
      let top: number;
      let right: number;
      let width: number;
      if (anchorKey === null) {
        // Deleted FIRST block → anchor at doc head, above the current
        // first block. Resolve that block through the same snapshot the
        // other branches use (`snap.getDOM`) rather than a raw
        // `.ProseMirror > *` query: the first DOM child can be a
        // ProseMirror widget / decoration (narrow, zero-width), which
        // would collapse the marker and popover to the left gutter.
        const firstKey = snap.keys[0];
        const dom = firstKey ? snap.getDOM(firstKey) : null;
        if (dom) {
          const r = dom.getBoundingClientRect();
          top = r.top - cRect.top + container.scrollTop - 8;
          right = r.right - cRect.left + container.scrollLeft;
          width = r.width;
        } else {
          top = container.scrollTop;
          right = cRect.width;
          width = cRect.width;
        }
      } else {
        const dom = snap.getDOM(anchorKey);
        if (!dom) continue;
        const rect = dom.getBoundingClientRect();
        top = rect.bottom - cRect.top + container.scrollTop - 6;
        right = rect.right - cRect.left + container.scrollLeft;
        width = rect.width;
      }
      next.push({ kind: 'tomb', anchorKey, entries, top, right, width });
    }
    setSlots(next);
  };

  useEffect(() => {
    recomputeRef.current();

    // Provenance now arrives together with the content it describes (the
    // server stamps `data.provenance` and broadcasts it with the delta).
    // When an AI edit swaps the whole doc, the synchronous recompute
    // above can measure an anchor block before ProseMirror has finished
    // laying out the new content, so a tombstone flashes at the wrong
    // spot before self-correcting. Re-measure across the next two frames
    // once the editor DOM has settled.
    let settleRaf = window.requestAnimationFrame(() => {
      settleRaf = window.requestAnimationFrame(() => {
        settleRaf = 0;
        recomputeRef.current();
      });
    });

    const container = containerRef.current;
    if (!container || !editor) {
      return () => {
        if (settleRaf !== 0) window.cancelAnimationFrame(settleRaf);
      };
    }

    // rAF-throttle: characterData mutations fire on every keystroke,
    // so coalesce bursts into one recompute per frame.
    let raf = 0;
    const schedule = () => {
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        recomputeRef.current();
      });
    };

    const mo = new MutationObserver(schedule);
    mo.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // A full-doc swap (AI edit) can reflow the editor over several
    // frames — the new first block may momentarily render narrower than
    // its final full width, which throws off the right-gutter anchor of
    // a doc-head tombstone. A MutationObserver only fires on DOM edits,
    // not on layout/size settling, so also watch the ProseMirror element
    // for resize and re-measure when its box changes.
    const pmEl = container.querySelector('.ProseMirror');
    const ro =
      pmEl && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    if (pmEl && ro) ro.observe(pmEl);

    container.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);

    return () => {
      if (settleRaf !== 0) window.cancelAnimationFrame(settleRaf);
      if (raf !== 0) window.cancelAnimationFrame(raf);
      mo.disconnect();
      ro?.disconnect();
      container.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [editor, containerRef, sig]);

  const scheduleHide = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setHovered(null), 150);
  }, []);
  const cancelHide = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
  }, []);

  // Only the narrow gutter marker owns the block diff popover. Keeping the
  // text body outside this hit area lets users read and select it without
  // repeatedly opening provenance UI.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !editor || blocks.length === 0) return;

    const blockKeySet = new Set(blocks.map((b) => b.key));
    const onMove = (e: MouseEvent) => {
      // If we're inside the popover itself, keep it open.
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-prov-popover]')) {
        cancelHide();
        return;
      }
      // Walk current slot list and check if pointer lies near an edited
      // block's gutter marker.
      const cRect = container.getBoundingClientRect();
      const xLocal = e.clientX - cRect.left + container.scrollLeft;
      const yLocal = e.clientY - cRect.top + container.scrollTop;
      for (const slot of slots) {
        if (slot.kind !== 'block') continue;
        if (!blockKeySet.has(slot.entry.key)) continue;
        if (isPointInEditedBlockGutter(xLocal, yLocal, slot)) {
          cancelHide();
          if (hovered?.kind !== 'block' || hovered.key !== slot.entry.key) {
            setHovered({ kind: 'block', key: slot.entry.key });
          }
          return;
        }
      }
      if (hovered?.kind === 'block') scheduleHide();
    };
    const onLeave = () => scheduleHide();

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', onLeave);
    };
  }, [containerRef, editor, blocks, slots, hovered, scheduleHide, cancelHide]);

  // Nothing to render if no slots have been measured yet. The bulk
  // summary pill lives in the outer (non-scrolling) panel and is
  // rendered by `<NotePreview>` directly.
  if (slots.length === 0) return null;

  const tombId = (anchorKey: string | null): string => anchorKey ?? '__head__';

  const hoveredSlot =
    hovered === null
      ? null
      : (slots.find((s) =>
          s.kind === 'block' && hovered.kind === 'block'
            ? s.entry.key === hovered.key
            : s.kind === 'tomb' && hovered.kind === 'tomb'
              ? tombId(s.anchorKey) === hovered.key
              : false,
        ) ?? null);

  return (
    <>
      {/* Tombstone gutter markers (always visible). One marker per
          anchor group — multiple consecutive deletes at the same
          anchor share a single bar + popover. Shape mirrors the
          modify/insert accent bar so the three provenance states read
          as a unified family in the gutter. */}
      {slots.map((slot) => {
        if (slot.kind !== 'tomb') return null;
        const id = tombId(slot.anchorKey);
        const active = hovered?.kind === 'tomb' && hovered.key === id;
        const count = slot.entries.length;
        // Mirror the `.huabu-ai-edited-block::after` accent bar
        // (see `milkdown-overrides.css`): 6 px wide vertical bar with
        // 1 px border-radius, sitting in the same gutter column as the
        // modify/insert bars but using the `--danger` token. A wider
        // invisible hit area (12 px) keeps the marker comfortably
        // hoverable without making the visible bar feel chunky.
        return (
          <div
            key={`tm:${id}`}
            className="absolute z-10 flex cursor-pointer items-center"
            style={{
              top: slot.top - 2,
              left: slot.right + 3,
              width: 12,
              height: 16,
            }}
            onMouseEnter={() => {
              cancelHide();
              setHovered({ kind: 'tomb', key: id });
            }}
            onMouseLeave={scheduleHide}
            title={
              count > 1
                ? `AI deleted ${count} blocks here — hover to review`
                : 'AI deleted this block — hover to review'
            }
          >
            <div
              style={{
                width: 6,
                height: 16,
                marginLeft: 3,
                borderRadius: 1,
                backgroundColor: active
                  ? 'var(--danger)'
                  : 'var(--danger-light)',
                transition: 'background-color 0.15s ease',
                pointerEvents: 'none',
              }}
            />
          </div>
        );
      })}

      {/* Hover popover (single instance, anchored to whichever slot is
          currently hovered) */}
      {hoveredSlot ? (
        <DiffPopover
          slot={hoveredSlot}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
          editor={editor}
          onAcceptBlock={onAcceptBlock}
          onRejectBlock={onRejectBlock}
          onInsertBelow={onInsertBelow}
          onRestoreTombstone={onRestoreTombstone}
          onDismissTombstone={onDismissTombstone}
          onClose={() => setHovered(null)}
        />
      ) : null}
    </>
  );
}

interface DiffPopoverProps {
  slot: Slot;
  editor: MilkdownInstance | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onAcceptBlock: (key: string) => void;
  onRejectBlock: (key: string) => void;
  onInsertBelow?: (key: string, baselineMarkdown: string) => void;
  onRestoreTombstone: (
    deletedKey: string,
    markdown: string,
    anchorKey: string | null,
  ) => void;
  onDismissTombstone: (deletedKey: string) => void;
  onClose: () => void;
}

function DiffPopover({
  slot,
  editor,
  onMouseEnter,
  onMouseLeave,
  onAcceptBlock,
  onRejectBlock,
  onInsertBelow,
  onRestoreTombstone,
  onDismissTombstone,
  onClose,
}: DiffPopoverProps) {
  // Compute diff content based on slot kind. Tombstone groups
  // concatenate every entry's baseline (rendered as one strike-through
  // block per entry inside the popover body).
  const segments = useMemo<
    | { kind: 'diff'; rows: DiffSegment[][] }
    | { kind: 'tomb'; entries: ReadonlyArray<DeletedBlockInfo> }
  >(() => {
    if (slot.kind === 'block') {
      const live =
        editor?.getBlockMarkdownByKey(slot.entry.key) ??
        slot.entry.baselineMarkdown;
      return {
        kind: 'diff',
        rows: computeDisplayDiffs(slot.entry.baselineMarkdown, live),
      };
    }
    return { kind: 'tomb', entries: slot.entries };
  }, [slot, editor]);

  // Match the popover width to the anchor block (legacy behaviour);
  // right edge aligns with the gutter bar.
  const style: React.CSSProperties = {
    top: slot.kind === 'block' ? slot.top : slot.top + 12,
    left: slot.right + GUTTER_OFFSET,
    width: slot.width,
    transform: 'translateX(-100%)',
  };

  return (
    <div
      data-prov-popover
      className="border-edge-default bg-surface absolute z-20 max-h-100 overflow-y-auto rounded-md border p-3 shadow-lg"
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="text-fg-muted mb-2 text-xs leading-relaxed">
        {segments.kind === 'diff'
          ? segments.rows.map((row, rowIndex) => (
              <div
                key={rowIndex}
                className={rowIndex > 0 ? 'mt-1 border-t pt-1' : ''}
              >
                {row.map((seg, segmentIndex) => (
                  <span
                    key={segmentIndex}
                    className={
                      seg.type === 'removed'
                        ? 'bg-diff-removed-bg text-diff-removed-text line-through'
                        : seg.type === 'added'
                          ? 'bg-diff-added-bg text-diff-added-text'
                          : ''
                    }
                  >
                    {seg.text}
                  </span>
                ))}
              </div>
            ))
          : segments.entries.map((entry, i) => (
              <div
                key={entry.key}
                className={`bg-diff-removed-bg text-diff-removed-text line-through ${
                  i > 0 ? 'mt-1 pt-1' : ''
                }`}
              >
                {entry.baselineMarkdown}
              </div>
            ))}
      </div>
      <div className="flex justify-end gap-1">
        {slot.kind === 'block' ? (
          <>
            {onInsertBelow ? (
              <Button
                variant="outline"
                tone="neutral"
                size="sm"
                onClick={() => {
                  onInsertBelow(slot.entry.key, slot.entry.baselineMarkdown);
                  onClose();
                }}
              >
                Insert Below
              </Button>
            ) : null}
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={() => {
                onRejectBlock(slot.entry.key);
                onClose();
              }}
            >
              Reject
            </Button>
            <Button
              variant="solid"
              tone="info"
              size="sm"
              onClick={() => {
                onAcceptBlock(slot.entry.key);
                onClose();
              }}
            >
              Accept
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={() => {
                // Reject = restore deleted blocks back into the doc
                // (legacy semantics).
                for (const entry of slot.entries) {
                  onRestoreTombstone(
                    entry.key,
                    entry.baselineMarkdown,
                    entry.anchorKey,
                  );
                }
                onClose();
              }}
            >
              Reject
            </Button>
            <Button
              variant="solid"
              tone="info"
              size="sm"
              onClick={() => {
                // Accept = confirm the deletion (drop tombstone entries).
                for (const entry of slot.entries) {
                  onDismissTombstone(entry.key);
                }
                onClose();
              }}
            >
              Accept
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
