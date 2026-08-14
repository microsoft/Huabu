// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode, useStore, useViewport } from '@xyflow/react';
import clsx from 'clsx';
import { Columns3, Grid2x2, Move, Rows3, Ungroup } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  FRAME_GRID_MAX_COUNT,
  FRAME_GRID_MIN_COUNT,
  type FrameLayoutMode,
} from '@huabu/shared';
import { clampGridCount } from '@huabu/shared/canvas-engine';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { Input } from '@/components/Common/Input.tsx';
import { MissingFileBanner } from '@/components/Nodes/MissingFileBanner.tsx';
import { NodeWrapper } from '@/components/Nodes/NodeWrapper.tsx';
import useCanvasStore from '@/store/canvasStore.ts';

import { shouldPreserveFrameAspectRatio } from './frameResizePolicy.ts';

import type { CanvasFrameNodeData } from '@/components/Nodes/types.ts';
import type { Node, NodeProps } from '@xyflow/react';

export type FrameNodeType = Node<CanvasFrameNodeData, 'frame'>;

const LABEL_MIN_VERTICAL_GAP = 22;
const LABEL_COLLISION_HYSTERESIS = 4;
const LABEL_MIN_SCREEN_WIDTH = 48;

function shouldShowNestedLabel(
  ancestorGap: number | null,
  wasVisible: boolean | null,
): boolean {
  if (ancestorGap === null) return true;

  const threshold =
    wasVisible === null
      ? LABEL_MIN_VERTICAL_GAP
      : wasVisible
        ? LABEL_MIN_VERTICAL_GAP - LABEL_COLLISION_HYSTERESIS
        : LABEL_MIN_VERTICAL_GAP + LABEL_COLLISION_HYSTERESIS;

  return Math.abs(ancestorGap) >= threshold;
}

// ── Toolbar metadata ───────────────────────────────────────────────────

const LAYOUT_MODE_OPTIONS: Array<{
  value: FrameLayoutMode;
  label: string;
  icon: React.ReactNode;
}> = [
  { value: 'free', label: 'Free', icon: <Move /> },
  { value: 'column', label: 'Column', icon: <Columns3 /> },
  { value: 'row', label: 'Row', icon: <Rows3 /> },
  { value: 'grid', label: 'Grid', icon: <Grid2x2 /> },
];

/**
 * Compact numeric input styled to match the W / H size inputs used in
 * the multi-select toolbar. Narrower (`w-8`) since the value is at most
 * two digits.
 */
const COUNT_INPUT_CLASS =
  'border-edge-default focus:border-info nodrag w-8 rounded border bg-transparent px-1.5 py-0.5 text-center text-xs outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

// ── Component ──────────────────────────────────────────────────────────

export const FrameNode = memo(
  ({ id, data, selected }: NodeProps<FrameNodeType>) => {
    const { t } = useTranslation();
    const unframe = useCanvasStore((state) => state.unframe);
    const tryRename = useCanvasStore((state) => state.tryRename);
    const dispatchUiIntent = useCanvasStore((state) => state.dispatchUiIntent);
    const captureFrameResizeSnapshot = useCanvasStore(
      (state) => state.captureFrameResizeSnapshot,
    );
    const applyFrameResizeScale = useCanvasStore(
      (state) => state.applyFrameResizeScale,
    );
    const clearFrameResizeSnapshot = useCanvasStore(
      (state) => state.clearFrameResizeSnapshot,
    );
    const flushFrameResizeScale = useCanvasStore(
      (state) => state.flushFrameResizeScale,
    );
    // Subscribe to the live child count so the count input's upper
    // bound tracks "items inside this frame". Returns a plain number,
    // so this subscription only re-renders FrameNode when the count
    // itself changes.
    const childCount = useCanvasStore(
      (state) => state.nodes.filter((n) => n.parentId === id).length,
    );
    const hasMediaChild = useCanvasStore((state) =>
      state.nodes.some(
        (node) =>
          node.parentId === id &&
          (node.type === 'image' || node.type === 'video'),
      ),
    );

    const layoutMode: FrameLayoutMode = data.layoutMode ?? 'free';
    const isContentMissing = data.contentMissing === true;
    const isStructuredLayout = layoutMode !== 'free';
    // `grid` counts columns just like `column` does — only `row`
    // reinterprets the track count as rows.
    const countsRows = layoutMode === 'row';
    const count = clampGridCount(data.gridCount);

    // `grid` is the one two-dimensional mode, so a single count input
    // could only ever tell half the story. This is the live row total —
    // what the layout actually resolved to, which is not always what was
    // asked for: rows can be added (blank cells are meaningful in
    // `grid`) but never dropped below what the children need.
    const gridRowCount = useCanvasStore((state) => {
      if (layoutMode !== 'grid') return 0;
      let maxRow = -1;
      for (const node of state.nodes) {
        if (node.parentId !== id) continue;
        const row = (node.data as { frameRow?: number } | undefined)?.frameRow;
        if (typeof row === 'number' && row > maxRow) maxRow = row;
      }
      return Math.max(maxRow + 1, data.gridRowCount ?? 0);
    });

    // Sizing policy lives in `data.sizing` (default `'hug'`) and is
    // surfaced through the shared size picker's auto-toggle that
    // `NodeFloatingToolbar` renders for frame nodes. The toggle and
    // the W/H inputs both dispatch `SET_FRAME_LAYOUT_MODE` /
    // `RESIZE_NODE` directly from there — this node only owns the
    // layout-mode + grid-count controls (rendered below as
    // `FrameActions`).

    // Local draft for the count input so the user can type freely
    // without the value reformatting on every keystroke. Re-synced
    // from the canonical value when it changes externally.
    const [countDraft, setCountDraft] = useState(String(count));
    useEffect(() => {
      setCountDraft(String(count));
    }, [count]);

    // Same pattern for the `grid` row input. It is re-synced from the
    // RESOLVED row total, not from what was typed: asking for fewer
    // rows than the children need cannot be honoured, and echoing the
    // request back would claim otherwise.
    const [rowDraft, setRowDraft] = useState(String(gridRowCount));
    useEffect(() => {
      setRowDraft(String(gridRowCount));
    }, [gridRowCount]);

    /**
     * Effective upper bound for the count input:
     *  - At most `FRAME_GRID_MAX_COUNT` (12).
     *  - At most `childCount` so the "no empty track" invariant can
     *    always be satisfied. Empty frames still allow a count of 1.
     */
    const maxCount = Math.min(
      FRAME_GRID_MAX_COUNT,
      Math.max(FRAME_GRID_MIN_COUNT, childCount || FRAME_GRID_MIN_COUNT),
    );

    const internalNode = useInternalNode(id);
    const { zoom } = useViewport();
    const nearestFrameAncestorY = useStore((state) => {
      let current = state.nodeLookup.get(id);
      const visited = new Set<string>([id]);
      while (current?.parentId && !visited.has(current.parentId)) {
        visited.add(current.parentId);
        const parent = state.nodeLookup.get(current.parentId);
        if (!parent) return null;
        if (parent.type === 'frame') {
          return parent.internals.positionAbsolute?.y ?? null;
        }
        current = parent;
      }
      return null;
    });
    // Only a container frame (with at least one direct child) can hold a
    // colliding selected descendant frame. A frame with zero children has an
    // empty subtree, so it can skip the whole-graph scan entirely — this
    // keeps the O(nodes) sweep off the vast majority of (leaf) frames and
    // leaves it running only for the few frames that actually nest.
    const isContainerFrame = childCount > 0;
    const selectedDescendantFrameY = useStore((state) => {
      if (!isContainerFrame) return null;
      for (const candidate of state.nodeLookup.values()) {
        if (
          candidate.id === id ||
          candidate.type !== 'frame' ||
          !candidate.selected
        ) {
          continue;
        }

        let current = candidate;
        const visited = new Set<string>([candidate.id]);
        while (current.parentId && !visited.has(current.parentId)) {
          visited.add(current.parentId);
          if (current.parentId === id) {
            return candidate.internals.positionAbsolute?.y ?? null;
          }
          const parent = state.nodeLookup.get(current.parentId);
          if (!parent) break;
          current = parent;
        }
      }
      return null;
    });

    const absY = internalNode?.internals.positionAbsolute?.y ?? 0;
    const styleWidth = internalNode?.style?.width;
    const nodeWidth =
      (typeof styleWidth === 'number' ? styleWidth : undefined) ??
      internalNode?.measured?.width ??
      LABEL_MIN_SCREEN_WIDTH;
    const ancestorGap =
      nearestFrameAncestorY === null
        ? null
        : (absY - nearestFrameAncestorY) * zoom;
    const previousLabelVisibilityRef = useRef<boolean | null>(null);
    const collisionVisible = shouldShowNestedLabel(
      ancestorGap,
      previousLabelVisibilityRef.current,
    );
    previousLabelVisibilityRef.current = collisionVisible;
    const selectedDescendantCollides =
      selectedDescendantFrameY !== null &&
      !shouldShowNestedLabel((selectedDescendantFrameY - absY) * zoom, null);
    const labelSemanticallyVisible =
      collisionVisible && !selectedDescendantCollides;

    const commitCount = () => {
      const trimmed = countDraft.trim();
      if (trimmed === '') {
        setCountDraft(String(count));
        return;
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(parsed)) {
        setCountDraft(String(count));
        return;
      }
      // Clamp to [min, maxCount] — exceeding child count is silently
      // capped so the "no empty track" invariant always holds.
      const next = Math.min(maxCount, Math.max(FRAME_GRID_MIN_COUNT, parsed));
      setCountDraft(String(next));
      if (next === count) return;
      dispatchUiIntent({
        type: 'SET_FRAME_LAYOUT_MODE',
        frameId: id,
        mode: layoutMode,
        gridCount: next,
      });
    };

    const commitRowCount = () => {
      const trimmed = rowDraft.trim();
      const parsed = Number.parseInt(trimmed, 10);
      if (trimmed === '' || !Number.isFinite(parsed)) {
        setRowDraft(String(gridRowCount));
        return;
      }
      const next = Math.min(
        FRAME_GRID_MAX_COUNT,
        Math.max(FRAME_GRID_MIN_COUNT, parsed),
      );
      // Compare against the PERSISTED floor, not the displayed total.
      // They differ whenever the content already needs more rows than
      // were pinned, and comparing the displayed value would swallow
      // the most natural request there is: "keep what I see now", i.e.
      // pin the current row count so later deletions cannot shrink it.
      if (next === data.gridRowCount) {
        setRowDraft(String(gridRowCount));
        return;
      }
      dispatchUiIntent({
        type: 'SET_FRAME_LAYOUT_MODE',
        frameId: id,
        mode: layoutMode,
        gridRowCount: next,
      });
      // Deliberately no optimistic draft update: the request is a floor,
      // so the resolved total may be higher. The effect above re-syncs
      // once the solver has spoken.
    };

    const setMode = (next: FrameLayoutMode) => {
      dispatchUiIntent({
        type: 'SET_FRAME_LAYOUT_MODE',
        frameId: id,
        mode: next,
        // Deliberately no `gridCount` / `gridRowCount`: naming either
        // here would re-flow the frame against a number chosen for the
        // previous mode. Omitting them lets the solver read the track
        // structure off the children's current positions, so switching
        // modes preserves the arrangement instead of collapsing it.
      });
    };

    const FrameActions = (
      <>
        <FloatingToolbar.Select
          options={LAYOUT_MODE_OPTIONS.map((option) => ({
            ...option,
            label:
              option.value === 'free'
                ? t('node.frameLayoutFree')
                : option.value === 'column'
                  ? t('node.frameLayoutColumn')
                  : option.value === 'row'
                    ? t('node.frameLayoutRow')
                    : t('node.frameLayoutGrid'),
          }))}
          value={layoutMode}
          onChange={setMode}
        />

        {isStructuredLayout && (
          <div className="flex items-center gap-1">
            {/*
              `grid` reads "rows x columns", matching how a matrix is
              written and how the pair is said out loud. The row box
              therefore comes first even though the column count is the
              stronger constraint (exact, vs. a floor for rows) — the
              convention the user already carries beats our internal
              ordering.
            */}
            {layoutMode === 'grid' && (
              <>
                <input
                  type="number"
                  inputMode="numeric"
                  aria-label={t('node.rows')}
                  title={t('node.gridRowsMin')}
                  min={FRAME_GRID_MIN_COUNT}
                  max={FRAME_GRID_MAX_COUNT}
                  step={1}
                  value={rowDraft}
                  onChange={(e) => setRowDraft(e.target.value)}
                  onBlur={commitRowCount}
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      commitRowCount();
                      (e.target as HTMLInputElement).blur();
                    } else if (e.key === 'Escape') {
                      setRowDraft(String(gridRowCount));
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className={COUNT_INPUT_CLASS}
                />
                <span
                  className="text-fg-subtle text-xs select-none"
                  aria-hidden="true"
                >
                  {'\u00d7'}
                </span>
              </>
            )}
            <input
              type="number"
              inputMode="numeric"
              aria-label={countsRows ? t('node.rows') : t('node.columns')}
              title={
                countsRows
                  ? t('node.rowsRange', { max: maxCount })
                  : t('node.columnsRange', { max: maxCount })
              }
              min={FRAME_GRID_MIN_COUNT}
              max={maxCount}
              step={1}
              value={countDraft}
              onChange={(e) => setCountDraft(e.target.value)}
              onBlur={commitCount}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  commitCount();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Escape') {
                  setCountDraft(String(count));
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className={COUNT_INPUT_CLASS}
            />
          </div>
        )}

        <FloatingToolbar.Divider />

        <FloatingToolbar.ActionButton
          title={t('node.unframe')}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            unframe(id);
          }}
        >
          <Ungroup />
        </FloatingToolbar.ActionButton>
      </>
    );

    const label = useMemo(() => {
      const raw = typeof data.label === 'string' ? data.label : '';
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : t('layers.filterLabels.frame');
    }, [data.label, t]);

    const [isEditingLabel, setIsEditingLabel] = useState(false);
    const [draftLabel, setDraftLabel] = useState(label);
    const labelInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      if (isEditingLabel) return;
      setDraftLabel(label);
    }, [isEditingLabel, label]);

    useEffect(() => {
      if (!isEditingLabel) return;
      labelInputRef.current?.focus();
      labelInputRef.current?.select();
    }, [isEditingLabel]);

    const commitLabel = () => {
      const next = draftLabel.trim() || t('layers.filterLabels.frame');
      // Route through tryRename so a sibling-label collision triggers the
      // shared alert + revert flow instead of silently overwriting state.
      void tryRename('node', id, next).then((accepted) => {
        if (!accepted) setDraftLabel(label);
      });
      setIsEditingLabel(false);
    };

    // ── Resize gesture handlers ────────────────────────────────────────
    //
    // Wired into NodeWrapper's NodeResizer callbacks so the frame
    // shows a live preview while the user drags, instead of jumping
    // to the final layout at gesture end. All layout modes share the
    // same content-driven path:
    //
    //  - At resize-start we snapshot every direct child's pre-gesture
    //    position + size.
    //  - On every tick we scale the children proportionally (both
    //    axes) to the frame's new dimensions and dispatch them in a
    //    single batch via `applyFrameResizeScale`, together with the
    //    frame's NEW local top-left (`x`, `y`). Forwarding the new
    //    origin matters for non-BR-corner handles (TL/TR/BL/T/L):
    //    the frame's TL moves every tick and the dispatched batch
    //    pins it directly, instead of leaving the position update
    //    to a separate `onNodesChange` snap-mirror pass — which
    //    used to leave the preview (and the post-resize commit)
    //    one frame stale and produced visibly mis-placed children.
    //  - `free` keeps the scaled child positions; `column` / `row` /
    //    `grid` let the grid solver re-pack the scaled children at the
    //    end of each tick's batch, so the content-driven frame size
    //    tracks the drag while preserving each child's size ratios.
    //  - The per-tick dispatch is rAF-coalesced (one batch per paint)
    //    so high-refresh `onResize` floods don't re-run the command
    //    pipeline + grid solver dozens of times per frame. At
    //    resize-end we `flushFrameResizeScale()` first so the trailing
    //    (coalesced-away) tick lands before the snapshot is cleared.
    //  - The snapshot is cleared at resize-end.
    //
    // Every path re-uses the single undo snapshot taken at
    // `onNodeResizeStart` — preview ticks dispatch through
    // `previewResizeGeometry`, which re-arms the gesture-snapshot
    // flag so the executor's safety warning stays quiet without any
    // extra history entries being pushed.
    const handleFrameResizeStart = useCallback(() => {
      captureFrameResizeSnapshot(id);
    }, [id, captureFrameResizeSnapshot]);

    const handleFrameResize = useCallback(
      (width: number, height: number, x: number, y: number) => {
        applyFrameResizeScale(width, height, x, y);
      },
      [applyFrameResizeScale],
    );

    const handleFrameResizeEnd = useCallback(() => {
      // Land the trailing rAF-coalesced scale tick (if any) before
      // tearing down the snapshot, so children don't end the gesture
      // one paint behind the frame's committed final size.
      flushFrameResizeScale();
      clearFrameResizeSnapshot();
    }, [flushFrameResizeScale, clearFrameResizeSnapshot]);

    // Rendered in the zoom-invariant overlay so the label keeps a fixed screen size
    const labelOverlay = (
      <div className="relative inline-grid max-w-full min-w-0 items-center">
        <span className="invisible col-start-1 row-start-1 min-w-0 truncate px-1.5 text-xs font-medium whitespace-pre">
          {draftLabel || ' '}
        </span>

        <Input
          ref={labelInputRef}
          value={draftLabel}
          readOnly={!isEditingLabel}
          title={t('node.editFrameName')}
          wrapperClassName="col-start-1 row-start-1 min-w-0 w-full"
          tooltipOffset={0}
          size={1}
          className={clsx(
            'nodrag col-start-1 row-start-1 w-full min-w-0! bg-transparent px-1.5 text-xs font-medium outline-none',
            isEditingLabel
              ? 'text-fg-default cursor-text'
              : 'text-fg-muted hover:text-fg-default cursor-pointer',
          )}
          onChange={(e) => {
            if (!isEditingLabel) return;
            setDraftLabel(e.target.value);
          }}
          onClick={() => {
            if (isEditingLabel) return;
            setIsEditingLabel(true);
          }}
          onBlur={() => {
            if (!isEditingLabel) return;
            commitLabel();
          }}
          onKeyDown={(e) => {
            if (!isEditingLabel) return;
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commitLabel();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDraftLabel(label);
              setIsEditingLabel(false);
            }
          }}
        />
      </div>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'frame'}
        selected={selected && !isEditingLabel}
        actions={isContentMissing ? undefined : FrameActions}
        overlayContent={isContentMissing ? undefined : labelOverlay}
        overlayOffsetY={-24}
        overlayVisible={labelSemanticallyVisible}
        overlayInteractionPriority={isEditingLabel ? 3 : selected ? 2 : 0}
        overlayMaxWidth={Math.max(LABEL_MIN_SCREEN_WIDTH, nodeWidth * zoom)}
        keepAspectRatio={shouldPreserveFrameAspectRatio({
          sizing: data.sizing,
          hasMediaChild,
        })}
        // Resize is enabled for every layout mode and shares one
        // content-driven path: dragging the frame scales every direct
        // child proportionally (both axes) about the frame origin.
        //  - `free`:  children keep their scaled positions, so the
        //    whole cluster grows/shrinks with the box.
        //  - `column` / `row` / `grid`: the grid solver re-packs the
        //    scaled children, so the frame snaps to the new content
        //    size while each child's size ratio is preserved.
        resizable
        onResizeStart={handleFrameResizeStart}
        onResize={handleFrameResize}
        onResizeEnd={handleFrameResizeEnd}
        allowOverflow
      >
        {isContentMissing ? (
          <MissingFileBanner nodeId={id} />
        ) : (
          <div className="h-full w-full" />
        )}
      </NodeWrapper>
    );
  },
);
