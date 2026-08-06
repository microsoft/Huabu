// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { Plus } from 'lucide-react';
import React, { useMemo } from 'react';

import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import type { StructuredDropPreview } from '@/store/gesturePreviewStore';
import type { StructuredDropContextRect } from '@huabu/shared/canvas-engine';
import type { ReactFlowInstance } from '@xyflow/react';

type ScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Live drop indicator shown while dragging a node over a structured
 * (column / row / grid) frame.
 *
 * The heavy lifting is done by the **live reflow** in
 * `canvasStore.onNodeDrag`: the frame's peers physically slide to the
 * positions the solver projected for this drop, so "what happens on
 * release" is shown by the canvas itself rather than by a stack of
 * translucent bands. That leaves this overlay two jobs:
 *
 * 1. **Mark the spot the dragged node will occupy**, which the reflow
 *    cannot show because the node is glued to the cursor. The rect is
 *    the solver's projected position at the dragged node's own size in
 *    every layout mode, so what is outlined is literally the footprint
 *    that commits. `insert-new` gets a dashed `+` treatment instead of
 *    a plain outline: a brand-new track displaces nothing, so the
 *    reflow cannot hint that the frame is about to gain a track.
 * 2. **Draw the frame's track structure** (`context.tracks` /
 *    `context.rows`), numbered and with the targeted track emphasised.
 *    Reflowed peers imply the tracks but never state them: a column
 *    holding one short card and an empty column look identical, and a
 *    grid row that no peer happens to occupy is invisible. The bands
 *    answer "how many rows / columns are there, and which cell am I
 *    over" directly, which peer motion alone cannot.
 *
 * Free-mode frames never populate the preview, so nothing renders.
 */
export const StructuredDropOverlay: React.FC<{
  rfInstance: ReactFlowInstance | null;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
}> = React.memo(({ rfInstance, wrapperRef }) => {
  const preview = useGesturePreviewStore((s) => s.structuredDropPreview);

  const projected = useMemo(() => {
    if (!preview || !rfInstance || !wrapperRef.current) return null;
    const wrapperRect = wrapperRef.current.getBoundingClientRect();
    const project = (rect: StructuredDropContextRect): ScreenRect => {
      const topLeft = rfInstance.flowToScreenPosition({
        x: rect.x,
        y: rect.y,
      });
      const bottomRight = rfInstance.flowToScreenPosition({
        x: rect.x + rect.width,
        y: rect.y + rect.height,
      });
      return {
        left: topLeft.x - wrapperRect.left,
        top: topLeft.y - wrapperRect.top,
        width: bottomRight.x - topLeft.x,
        height: bottomRight.y - topLeft.y,
      };
    };

    return {
      drop: project(preview),
      tracks: preview.context.tracks.map(project),
      rows: preview.context.rows.map(project),
    };
  }, [preview, rfInstance, wrapperRef]);

  if (!preview || !projected) return null;

  // `row` frames count rows as their tracks; `column` / `grid` count
  // columns, and `grid` additionally exposes its row bands.
  const tracksAreRows = preview.context.axis === 'row';

  return (
    <>
      <TrackBands
        bands={projected.tracks}
        active={preview.context.activeTrack}
        orientation={tracksAreRows ? 'horizontal' : 'vertical'}
      />
      <TrackBands
        bands={projected.rows}
        active={preview.context.activeRow}
        orientation="horizontal"
      />
      <DropMark preview={preview} rect={projected.drop} />
    </>
  );
});

StructuredDropOverlay.displayName = 'StructuredDropOverlay';

const DropMark: React.FC<{
  preview: StructuredDropPreview;
  rect: ScreenRect;
}> = ({ preview, rect }) => {
  if (preview.kind === 'insert-new') {
    return (
      <div
        className="bg-info/10 border-info/50 pointer-events-none absolute z-40 flex items-center justify-center rounded border-2 border-dashed"
        style={rect}
      >
        <span className="text-info flex items-center justify-center">
          <Plus size={20} strokeWidth={2.5} />
        </span>
      </div>
    );
  }

  return (
    <div
      className="border-info/60 pointer-events-none absolute z-40 rounded border-2"
      style={rect}
    />
  );
};

/**
 * Minimum on-screen extent (px) a band needs before it is worth
 * marking. Below this the index chip and its neighbours overlap into an
 * unreadable smudge, which is worse than showing nothing.
 */
const MIN_BAND_EXTENT = 6;

/**
 * Track structure for one axis of a structured frame: a hairline at
 * each boundary, a numbered chip per track in the frame's margin, and a
 * soft wash over the track being targeted.
 *
 * Deliberately **not** an outline per track. Boxing every track — on
 * both axes for `grid` — stacks a rectangle over each node, the drop
 * mark, and the frame's own border, and the resulting thicket buries
 * the one rect the user is steering. Boundaries are what actually
 * carry "where does this track end"; `n` tracks need only `n - 1` of
 * them, and the borderless wash plus the filled chip say which track is
 * live without adding another edge to read.
 *
 * Rendered only from two tracks up: a single track carries no
 * "which one am I in" question, and its boundary set is empty anyway.
 */
const TrackBands: React.FC<{
  bands: ScreenRect[];
  /** Index of the track this drop lands in; `-1` when unresolved. */
  active: number;
  orientation: 'vertical' | 'horizontal';
}> = ({ bands, active, orientation }) => {
  if (bands.length < 2) return null;
  const vertical = orientation === 'vertical';

  return (
    <>
      {bands.slice(0, -1).map((band, index) => {
        const next = bands[index + 1];
        // Boundaries sit mid-gutter, so a track's chip and wash read as
        // belonging to the span between two lines.
        const at = vertical
          ? (band.left + band.width + next.left) / 2
          : (band.top + band.height + next.top) / 2;
        return (
          <div
            key={`edge-${index}`}
            className="border-info/30 pointer-events-none absolute z-30"
            style={
              vertical
                ? {
                    left: at,
                    top: band.top,
                    height: band.height,
                    borderLeftWidth: 1,
                    borderLeftStyle: 'dashed',
                  }
                : {
                    top: at,
                    left: band.left,
                    width: band.width,
                    borderTopWidth: 1,
                    borderTopStyle: 'dashed',
                  }
            }
          />
        );
      })}

      {bands.map((band, index) => {
        if (band.width < MIN_BAND_EXTENT || band.height < MIN_BAND_EXTENT) {
          return null;
        }
        const isActive = index === active;
        return (
          <div
            key={index}
            className={clsx(
              'pointer-events-none absolute z-30',
              isActive && 'bg-info/8 rounded-sm',
            )}
            style={band}
          >
            <span
              className={clsx(
                'absolute flex h-4 min-w-4 items-center justify-center rounded-sm px-1 text-[10px] leading-none font-medium tabular-nums',
                vertical
                  ? '-top-5 left-1/2 -translate-x-1/2'
                  : 'top-1/2 -left-5 -translate-y-1/2',
                isActive ? 'bg-info text-fg-inverse' : 'bg-info/15 text-info',
              )}
            >
              {index + 1}
            </span>
          </div>
        );
      })}
    </>
  );
};
