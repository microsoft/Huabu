// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode } from '@xyflow/react';
import clsx from 'clsx';
import { Columns3, Grid2x2, Move, Rows3, Ungroup } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import {
  FRAME_GRID_MAX_COUNT,
  FRAME_GRID_MIN_COUNT,
  classifySpaceInstructionFrame,
  directAgentNodeIdsForFrame,
  resolveAccent,
  type FrameLayoutMode,
} from '@huabu/shared';
import { clampGridCount, frameAccentToken } from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { Input } from '@/components/Common/Input.tsx';
import { MissingFileBanner } from '@/components/Nodes/MissingFileBanner.tsx';
import { NodeWrapper } from '@/components/Nodes/NodeWrapper.tsx';
import useCanvasStore from '@/store/canvasStore.ts';

import { FRAME_DESIGN_CONFIG, frameVisualMetricsForSize } from './frameDesign';
import { FrameHeader } from './FrameHeader.tsx';
import { getFrameHeaderMetrics } from './frameHeaderMetrics.ts';
import { FrameRegionOverlay, FrameZoomHeader } from './FrameRegionLabel';
import { shouldPreserveFrameAspectRatio } from './frameResizePolicy.ts';

import type { CanvasFrameNodeData } from '@/components/Nodes/types.ts';
import type { Node, NodeProps } from '@xyflow/react';

export type FrameNodeType = Node<CanvasFrameNodeData, 'frame'>;

// ── Toolbar metadata ───────────────────────────────────────────────────

const LAYOUT_MODE_OPTIONS: Array<{
  value: FrameLayoutMode;
  label: string;
  icon: React.ReactNode;
}> = [
  { value: 'free', label: 'Free', icon: <Move /> },
  { value: 'row', label: 'Row', icon: <Rows3 /> },
  { value: 'column', label: 'Column', icon: <Columns3 /> },
  { value: 'grid', label: 'Grid', icon: <Grid2x2 /> },
];

/**
 * Compact numeric input styled to match the W / H size inputs used in
 * the multi-select toolbar. Narrower (`w-8`) since the value is at most
 * two digits.
 */

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
    const { childCount, hasMediaChild, contentInsetX } = useCanvasStore(
      useShallow((state) => {
        let childCount = 0;
        let hasMediaChild = false;
        let contentInsetX = Number.POSITIVE_INFINITY;

        for (const node of state.nodes) {
          if (node.parentId !== id) continue;
          childCount += 1;
          hasMediaChild ||=
            node.type === 'image' ||
            node.type === 'video' ||
            node.type === 'text' ||
            node.type === 'question';
          contentInsetX = Math.min(contentInsetX, node.position.x);
        }

        return {
          childCount,
          hasMediaChild,
          contentInsetX: Number.isFinite(contentInsetX) ? contentInsetX : null,
        };
      }),
    );
    const instructionFrameKind = classifySpaceInstructionFrame(
      data.label,
      data.labelSource,
    );
    const directAgentCount = useCanvasStore((state) =>
      instructionFrameKind === 'prompt'
        ? directAgentNodeIdsForFrame(state.nodes, state.edges, id).size
        : 0,
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
    const styleWidth = internalNode?.style?.width;
    const styleHeight = internalNode?.style?.height;
    const nodeWidth =
      (typeof styleWidth === 'number' ? styleWidth : undefined) ??
      internalNode?.measured?.width ??
      FRAME_DESIGN_CONFIG.header.minWidth;
    const nodeHeight =
      (typeof styleHeight === 'number' ? styleHeight : undefined) ??
      internalNode?.measured?.height ??
      FRAME_DESIGN_CONFIG.header.minWidth;
    const responsiveMetrics = frameVisualMetricsForSize(nodeWidth, nodeHeight);
    const headerMetrics = getFrameHeaderMetrics(
      contentInsetX,
      nodeWidth,
      responsiveMetrics.titleFontSize,
      responsiveMetrics.headerInset,
    );

    const commitCount = (parsed: number) => {
      // Clamp to [min, maxCount] — exceeding child count is silently
      // capped so the "no empty track" invariant always holds.
      const next = Math.min(maxCount, Math.max(FRAME_GRID_MIN_COUNT, parsed));
      if (next === count) return;
      dispatchUiIntent({
        type: 'SET_FRAME_LAYOUT_MODE',
        frameId: id,
        mode: layoutMode,
        gridCount: next,
      });
    };

    const commitRowCount = (parsed: number) => {
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
        return gridRowCount;
      }
      dispatchUiIntent({
        type: 'SET_FRAME_LAYOUT_MODE',
        frameId: id,
        mode: layoutMode,
        gridRowCount: next,
      });
      const nodes = useCanvasStore.getState().nodes;
      const frame = nodes.find((node) => node.id === id);
      return nodes.reduce(
        (rows, node) => {
          const row = node.data.frameRow;
          return node.parentId === id && typeof row === 'number'
            ? Math.max(rows, row + 1)
            : rows;
        },
        typeof frame?.data.gridRowCount === 'number'
          ? frame.data.gridRowCount
          : 0,
      );
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
      <DropdownMenu
        floating
        placement="bottom"
        className="node-toolbar-layout"
        trigger={
          <Button variant="ghost" iconOnly title={t('node.frameLayout')}>
            <Grid2x2 />
          </Button>
        }
      >
        <div
          className="node-toolbar-layout-modes"
          role="group"
          aria-label={t('node.frameLayout')}
        >
          {LAYOUT_MODE_OPTIONS.map((option) => (
            <Button
              key={option.value}
              variant="ghost"
              iconOnly
              aria-pressed={layoutMode === option.value}
              title={
                option.value === 'free'
                  ? t('node.frameLayoutFree')
                  : option.value === 'column'
                    ? t('node.frameLayoutColumn')
                    : option.value === 'row'
                      ? t('node.frameLayoutRow')
                      : t('node.frameLayoutGrid')
              }
              onClick={() => setMode(option.value)}
            >
              {option.icon}
            </Button>
          ))}
        </div>

        {isStructuredLayout && (
          <div className="node-toolbar-layout-counts">
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
                <FloatingToolbar.NumberInput
                  label={t('node.frameLayoutRow')}
                  ariaLabel={t('node.rows')}
                  name="frame-rows"
                  min={FRAME_GRID_MIN_COUNT}
                  max={FRAME_GRID_MAX_COUNT}
                  step={1}
                  value={gridRowCount}
                  applyUnchanged
                  onApply={commitRowCount}
                />
              </>
            )}
            <FloatingToolbar.NumberInput
              label={
                countsRows
                  ? t('node.frameLayoutRow')
                  : t('node.frameLayoutColumn')
              }
              ariaLabel={countsRows ? t('node.rows') : t('node.columns')}
              name="frame-count"
              min={FRAME_GRID_MIN_COUNT}
              max={maxCount}
              step={1}
              value={count}
              onApply={commitCount}
            />
          </div>
        )}
      </DropdownMenu>
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
    //  - At resize-start we snapshot the complete descendant subtree's
    //    pre-gesture position + size, grouped by immediate parent.
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

    const frameAccent = resolveAccent(frameAccentToken(data.style?.accent));
    const frameHeader = (
      <FrameHeader
        metrics={headerMetrics}
        accent={frameAccent}
        instructionKind={instructionFrameKind}
        directAgentCount={directAgentCount}
      >
        <span className="invisible col-start-1 row-start-1 min-w-0 truncate font-semibold whitespace-pre">
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
            'nodrag pointer-events-auto col-start-1 row-start-1 w-full min-w-0! bg-transparent font-semibold text-ellipsis outline-none',
            isEditingLabel
              ? 'text-fg-default cursor-text'
              : 'text-fg-default cursor-pointer',
          )}
          style={{
            fontSize: 'inherit',
            lineHeight: `${headerMetrics.height}px`,
          }}
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
      </FrameHeader>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'frame'}
        selected={selected && !isEditingLabel}
        actions={isContentMissing ? undefined : FrameActions}
        overflow={
          isContentMissing ? undefined : (
            <DropdownMenuItem icon={<Ungroup />} onClick={() => unframe(id)}>
              {t('node.unframe')}
            </DropdownMenuItem>
          )
        }
        borderRadius={responsiveMetrics.borderRadius}
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
          <div className="relative h-full w-full">
            <FrameZoomHeader id={id}>{frameHeader}</FrameZoomHeader>
            <FrameRegionOverlay
              id={id}
              title={label}
              childCount={childCount}
              accent={frameAccent}
              headerMetrics={headerMetrics}
            />
          </div>
        )}
      </NodeWrapper>
    );
  },
);
