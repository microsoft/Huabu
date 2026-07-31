import { Plus } from 'lucide-react';
import React, { useMemo } from 'react';

import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import type { StructuredDropContextRect } from '@sediment/shared/canvas-engine';
import type { ReactFlowInstance } from '@xyflow/react';

type ScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Live drop indicator shown while dragging a node over a structured
 * (column / row / grid) frame. Reads `structuredDropPreview` (absolute
 * flow-space geometry + decision) and projects it to the wrapper:
 *
 *  - every mode highlights the active track with a quiet tint;
 *  - `grid` additionally highlights the shared row band,
 *    with a full footprint at the solver's final row/column position;
 *  - `into-existing` → a full-track-width insertion caret (a line with
 *    end brackets and a centre plus) at the exact stack gap the node
 *    would slot into — a caret, not a footprint, so a large node can't
 *    occlude its neighbours;
 *  - `insert-new`    → a translucent dashed ghost block (the dragged
 *    node's width × height) with a centred add icon, marking where a
 *    new column / row opens.
 *  - occupied Grid cell → the current occupant gets a warning outline,
 *    and an occupant-sized dashed ghost marks its destination cell.
 *
 * Free-mode frames never populate the preview, so nothing renders.
 */
export const StructuredDropOverlay: React.FC<{
  rfInstance: ReactFlowInstance | null;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
}> = React.memo(({ rfInstance, wrapperRef }) => {
  const preview = useGesturePreviewStore((s) => s.structuredDropPreview);

  const screen = useMemo(() => {
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
      track: preview.context.trackRect
        ? project(preview.context.trackRect)
        : null,
      alignment: preview.context.alignmentRect
        ? project(preview.context.alignmentRect)
        : null,
      swap: preview.swap
        ? {
            from: project(preview.swap.from),
            to: project(preview.swap.to),
          }
        : null,
    };
  }, [preview, rfInstance, wrapperRef]);

  if (!preview || !screen) return null;

  const dropStyle = {
    left: screen.drop.left,
    top: screen.drop.top,
    width: screen.drop.width,
    height: screen.drop.height,
  };

  const dropIndicator =
    preview.kind === 'insert-new' ? (
      <div
        className="bg-info/12 border-info/50 pointer-events-none absolute z-40 flex items-center justify-center rounded border-2 border-dashed transition-all duration-100"
        style={dropStyle}
      >
        <span className="text-info flex items-center justify-center">
          <Plus size={20} strokeWidth={2.5} />
        </span>
      </div>
    ) : preview.indicator === 'caret' ? (
      <DropCaret rect={screen.drop} />
    ) : (
      <div
        className="bg-info/12 border-info/70 pointer-events-none absolute z-40 rounded border-2 transition-all duration-100"
        style={dropStyle}
      />
    );

  return (
    <>
      {screen.track && (
        <div
          className="bg-info/6 pointer-events-none absolute z-40 transition-all duration-100"
          style={screen.track}
        />
      )}
      {screen.alignment && (
        <div
          className="bg-info/8 pointer-events-none absolute z-40 transition-all duration-100"
          style={screen.alignment}
        />
      )}
      {dropIndicator}
      {screen.swap && (
        <>
          <div
            className="bg-warning/10 border-warning pointer-events-none absolute z-40 rounded border-2 transition-all duration-100"
            style={screen.swap.from}
          />
          <div
            className="bg-warning/8 border-warning/80 pointer-events-none absolute z-40 rounded border-2 border-dashed transition-all duration-100"
            style={screen.swap.to}
          />
        </>
      )}
    </>
  );
});

StructuredDropOverlay.displayName = 'StructuredDropOverlay';

const DropCaret: React.FC<{ rect: ScreenRect }> = ({ rect }) => {
  const horizontal = rect.width >= rect.height;

  return (
    <div
      className="pointer-events-none absolute z-40 transition-all duration-100"
      style={rect}
    >
      {horizontal ? (
        <>
          <span className="bg-info absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full" />
          <span className="bg-info absolute top-1/2 left-0 h-3 w-0.5 -translate-y-1/2 rounded-full" />
          <span className="bg-info absolute top-1/2 right-0 h-3 w-0.5 -translate-y-1/2 rounded-full" />
          <span className="bg-info absolute top-1/2 left-1/2 h-2 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full" />
        </>
      ) : (
        <>
          <span className="bg-info absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full" />
          <span className="bg-info absolute top-0 left-1/2 h-0.5 w-3 -translate-x-1/2 rounded-full" />
          <span className="bg-info absolute bottom-0 left-1/2 h-0.5 w-3 -translate-x-1/2 rounded-full" />
          <span className="bg-info absolute top-1/2 left-1/2 h-0.5 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full" />
        </>
      )}
    </div>
  );
};
