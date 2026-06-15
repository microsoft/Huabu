import { Plus } from 'lucide-react';
import React, { useMemo } from 'react';

import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import type { ReactFlowInstance } from '@xyflow/react';

/**
 * Live drop indicator shown while dragging a node over a structured
 * (column / row) frame. Reads `structuredDropPreview` (absolute
 * flow-space rect + decision) and projects it to the wrapper:
 *
 *  - `into-existing` → a full-track-width insertion caret (a line with
 *    end brackets and a centre plus) at the exact stack gap the node
 *    would slot into — a caret, not a footprint, so a large node can't
 *    occlude its neighbours;
 *  - `insert-new`    → a translucent dashed ghost block (the dragged
 *    node's width × height) with a centred add icon, marking where a
 *    new column / row opens.
 *
 * Free-mode frames never populate the preview, so nothing renders.
 */
export const StructuredDropOverlay: React.FC<{
  rfInstance: ReactFlowInstance | null;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
}> = React.memo(({ rfInstance, wrapperRef }) => {
  const preview = useGesturePreviewStore((s) => s.structuredDropPreview);

  const screenRect = useMemo(() => {
    if (!preview || !rfInstance || !wrapperRef.current) return null;

    const topLeft = rfInstance.flowToScreenPosition({
      x: preview.x,
      y: preview.y,
    });
    const bottomRight = rfInstance.flowToScreenPosition({
      x: preview.x + preview.width,
      y: preview.y + preview.height,
    });
    const wrapperRect = wrapperRef.current.getBoundingClientRect();

    return {
      left: topLeft.x - wrapperRect.left,
      top: topLeft.y - wrapperRect.top,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }, [preview, rfInstance, wrapperRef]);

  if (!preview || !screenRect) return null;

  const style = {
    left: screenRect.left,
    top: screenRect.top,
    width: screenRect.width,
    height: screenRect.height,
  };

  if (preview.kind === 'insert-new') {
    return (
      <div
        className="bg-info/12 border-info/50 pointer-events-none absolute z-40 flex items-center justify-center rounded-xl border-2 border-dashed transition-all duration-100"
        style={style}
      >
        <span className="text-info flex items-center justify-center">
          <Plus size={20} strokeWidth={2.5} />
        </span>
      </div>
    );
  }

  // `into-existing` → an insertion caret spanning the whole track. The
  // band is thin, so orient by its aspect: wide → horizontal caret
  // (column frame), tall → vertical caret (row frame). The line, end
  // brackets and centre plus are drawn at a fixed pixel size and
  // anchored to the band's edges / centre.
  const horizontal = screenRect.width >= screenRect.height;

  return (
    <div
      className="pointer-events-none absolute z-40 transition-all duration-100"
      style={style}
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
});

StructuredDropOverlay.displayName = 'StructuredDropOverlay';
