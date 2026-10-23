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
import { useTranslation } from 'react-i18next';

import { topLevelListItemMarkdown } from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import { Popover } from '@/components/Common/Popover';

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
  const { t } = useTranslation();
  const [slots, setSlots] = useState<Slot[]>([]);
  // Tomb groups are identified by their shared anchorKey (`__head__`
  // for the null-anchor doc-head group). Block hover keeps using the
  // entry's fingerprint key.
  const [hovered, setHovered] = useState<{
    kind: 'block' | 'tomb';
    key: string;
  } | null>(null);
  const hideTimerRef = useRef<number>(0);
  const markerRefs = useRef(new Map<string, HTMLButtonElement>());
  const panelRef = useRef<HTMLDivElement>(null);
  const keyboardOriginRef = useRef<HTMLButtonElement | null>(null);
  const completedOriginRef = useRef<HTMLButtonElement | null>(null);

  const focusReviewAction = useCallback(() => {
    const action = panelRef.current?.querySelector('button');
    action?.focus({ preventScroll: true });
    action?.scrollIntoView({ block: 'nearest' });
  }, []);

  const completeReview = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    completedOriginRef.current = panelRef.current?.contains(
      document.activeElement,
    )
      ? keyboardOriginRef.current
      : null;
    keyboardOriginRef.current = null;
    setHovered(null);
  }, []);

  const close = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    const origin = keyboardOriginRef.current;
    keyboardOriginRef.current = null;
    setHovered(null);
    origin?.focus({ preventScroll: true });
  }, []);

  useEffect(() => () => window.clearTimeout(hideTimerRef.current), []);

  useEffect(() => {
    const origin = keyboardOriginRef.current;
    if (origin && !origin.isConnected) {
      window.clearTimeout(hideTimerRef.current);
      keyboardOriginRef.current = null;
      setHovered(null);
    }
    const completed = completedOriginRef.current;
    if (!completed || completed.isConnected) return;
    completedOriginRef.current = null;
    if (document.activeElement !== document.body) return;
    const marker = [...markerRefs.current.values()].find(
      (element) => element.isConnected,
    );
    if (marker) {
      marker.focus({ preventScroll: true });
      marker.scrollIntoView({ block: 'nearest' });
    } else {
      editor?.focus();
    }
  }, [slots, editor]);

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
    hideTimerRef.current = window.setTimeout(() => {
      if (
        keyboardOriginRef.current ||
        panelRef.current?.contains(document.activeElement)
      )
        return;
      setHovered(null);
    }, 150);
  }, []);
  const cancelHide = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
  }, []);

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
      {slots.map((slot) => {
        const id =
          slot.kind === 'block' ? slot.entry.key : tombId(slot.anchorKey);
        const markerId = `${slot.kind}:${id}`;
        const active = hovered?.kind === slot.kind && hovered.key === id;
        const label =
          slot.kind === 'block'
            ? t('chat.reviewAIBlockChanges')
            : t('chat.reviewAIDeletions', { count: slot.entries.length });
        return (
          <Button
            key={markerId}
            ref={(element) => {
              if (element) markerRefs.current.set(markerId, element);
              else markerRefs.current.delete(markerId);
            }}
            variant="ghost"
            iconOnly
            size="sm"
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={active}
            className="focus-visible:outline-info absolute z-10 min-h-0 min-w-0 rounded-sm p-0 focus-visible:outline-2 focus-visible:outline-offset-2 enabled:hover:bg-transparent"
            style={{
              top: slot.kind === 'block' ? slot.top : slot.top - 2,
              left: slot.right + 3,
              width: 12,
              height: slot.kind === 'block' ? slot.height : 16,
            }}
            onClick={(event) => {
              cancelHide();
              keyboardOriginRef.current = event.currentTarget;
              setHovered({ kind: slot.kind, key: id });
              if (active) focusReviewAction();
            }}
            onMouseEnter={() => {
              if (keyboardOriginRef.current) return;
              cancelHide();
              setHovered({ kind: slot.kind, key: id });
            }}
            onMouseLeave={scheduleHide}
          >
            {slot.kind === 'tomb' && (
              <span
                aria-hidden="true"
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
            )}
          </Button>
        );
      })}

      {/* Hover popover (single instance, anchored to whichever slot is
          currently hovered) */}
      {hoveredSlot ? (
        <DiffPopover
          key={`${hoveredSlot.kind}:${hoveredSlot.kind === 'block' ? hoveredSlot.entry.key : tombId(hoveredSlot.anchorKey)}`}
          slot={hoveredSlot}
          reference={markerRefs.current.get(
            `${hoveredSlot.kind}:${hoveredSlot.kind === 'block' ? hoveredSlot.entry.key : tombId(hoveredSlot.anchorKey)}`,
          )}
          contentRef={panelRef}
          label={
            hoveredSlot.kind === 'block'
              ? t('chat.reviewAIBlockChanges')
              : t('chat.reviewAIDeletions', {
                  count: hoveredSlot.entries.length,
                })
          }
          onOpenAutoFocus={() => {
            if (keyboardOriginRef.current) focusReviewAction();
          }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
          editor={editor}
          onAcceptBlock={onAcceptBlock}
          onRejectBlock={onRejectBlock}
          onInsertBelow={onInsertBelow}
          onRestoreTombstone={onRestoreTombstone}
          onDismissTombstone={onDismissTombstone}
          onClose={completeReview}
          onDismiss={(reason) => {
            if (reason === 'escape') close();
            else {
              keyboardOriginRef.current = null;
              window.clearTimeout(hideTimerRef.current);
              setHovered(null);
            }
          }}
        />
      ) : null}
    </>
  );
}

interface DiffPopoverProps {
  slot: Slot;
  reference?: Element;
  contentRef: React.RefObject<HTMLDivElement | null>;
  label: string;
  onOpenAutoFocus: () => void;
  onDismiss: NonNullable<React.ComponentProps<typeof Popover>['onDismiss']>;
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
  reference,
  contentRef,
  label,
  onOpenAutoFocus,
  onDismiss,
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

  return (
    <Popover
      reference={reference}
      placement="bottom-end"
      contentRef={contentRef}
      onOpenAutoFocus={onOpenAutoFocus}
      onDismiss={onDismiss}
      style={{ width: slot.width }}
      className="max-h-[min(25rem,var(--popover-available-height,calc(100dvh-24px)))] overflow-y-auto overscroll-contain p-3 wrap-anywhere"
    >
      <div
        role="dialog"
        aria-label={label}
        data-prov-popover=""
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
    </Popover>
  );
}
