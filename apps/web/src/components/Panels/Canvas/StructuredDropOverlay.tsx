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
 * (column / row / grid) frame.
 *
 * The heavy lifting is done by the **live reflow** in
 * `canvasStore.onNodeDrag`: the frame's peers physically slide to the
 * positions the solver projected for this drop, so "what happens on
 * release" is shown by the canvas itself rather than by a stack of
 * translucent bands. That leaves this overlay with a single job —
 * marking the spot the dragged node will occupy, which the reflow
 * cannot show because the node is glued to the cursor:
 *
 *  - `into-existing` → a quiet outline of the vacated slot (a caret for
 *    column / row stacks, the target cell for grid);
 *  - `insert-new`    → a dashed ghost block (the dragged node's
 *    width × height) with a centred add icon, marking where a new
 *    column / row opens — peers cannot express this, since a brand-new
 *    track displaces nothing.
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

    return project(preview);
  }, [preview, rfInstance, wrapperRef]);

  if (!preview || !screen) return null;

  if (preview.kind === 'insert-new') {
    return (
      <div
        className="bg-info/10 border-info/50 pointer-events-none absolute z-40 flex items-center justify-center rounded border-2 border-dashed"
        style={screen}
      >
        <span className="text-info flex items-center justify-center">
          <Plus size={20} strokeWidth={2.5} />
        </span>
      </div>
    );
  }

  return preview.indicator === 'caret' ? (
    <DropCaret rect={screen} />
  ) : (
    <div
      className="border-info/60 pointer-events-none absolute z-40 rounded border-2"
      style={screen}
    />
  );
});

StructuredDropOverlay.displayName = 'StructuredDropOverlay';

const DropCaret: React.FC<{ rect: ScreenRect }> = ({ rect }) => {
  const horizontal = rect.width >= rect.height;

  return (
    <div className="pointer-events-none absolute z-40" style={rect}>
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
