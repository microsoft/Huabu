import React, { useCallback, useRef } from 'react';

import useCanvasStore from '../../store/canvasStore';
import { usePreviewStore } from '../../store/previewStore';
import { Canvas } from '../Editor/Canvas';
import { ExpandedNodePanel } from '../Editor/ExpandedNodePanel';

const SPLIT_MIN_PX = 200;
const SPLIT_DEFAULT_RATIO = 0.5;

/**
 * CenterArea renders the canvas and, when a node is expanded, either replaces
 * the canvas with the expanded panel or shows them side-by-side with a
 * draggable resize handle.
 */
export const CenterArea: React.FC = () => {
  const expandedNodeId = useCanvasStore((s) => s.expandedNodeId);
  const canvasExpandMode = useCanvasStore((s) => s.expandMode);

  const previewData = usePreviewStore((s) => s.previewData);
  const previewType = usePreviewStore((s) => s.previewType);
  const previewExpandMode = usePreviewStore((s) => s.expandMode);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const splitRatioRef = useRef(SPLIT_DEFAULT_RATIO);
  const [splitRatio, setSplitRatio] = React.useState(SPLIT_DEFAULT_RATIO);

  const hasPreview = !!previewData && !!previewType;
  const hasExpanded = !!expandedNodeId || hasPreview;

  // Determine effective expand mode based on what acts as the "expanded" content
  // Priority: Preview > Node Edit
  let isReplace = false;
  if (hasPreview) {
    isReplace = previewExpandMode === 'replace';
  } else if (expandedNodeId) {
    isReplace = canvasExpandMode === 'replace';
  }

  /* ---- Drag handle for split mode ---- */
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const startX = e.clientX;
      const startRatio = splitRatioRef.current;

      const onMove = (ev: PointerEvent) => {
        const container = containerRef.current;
        if (!container) return;
        const totalWidth = container.getBoundingClientRect().width;
        if (totalWidth <= 0) return;

        const dx = ev.clientX - startX;
        const deltaRatio = dx / totalWidth;
        const minRatio = SPLIT_MIN_PX / totalWidth;
        const maxRatio = 1 - minRatio;
        const next = Math.min(
          Math.max(startRatio + deltaRatio, minRatio),
          maxRatio,
        );
        splitRatioRef.current = next;
        setSplitRatio(next);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [],
  );

  /* ---- No expanded node: just canvas ---- */
  if (!hasExpanded) {
    return (
      <div ref={containerRef} className="h-full w-full">
        <Canvas />
      </div>
    );
  }

  /* ---- Replace mode: only expanded panel ---- */
  if (isReplace) {
    return (
      <div ref={containerRef} className="h-full w-full">
        <ExpandedNodePanel />
      </div>
    );
  }

  /* ---- Split mode: canvas + resize handle + expanded panel ---- */
  const leftPercent = splitRatio * 100;

  return (
    <div ref={containerRef} className="flex h-full w-full">
      {/* Canvas (left) */}
      <div className="h-full shrink-0" style={{ width: `${leftPercent}%` }}>
        <Canvas />
      </div>

      {/* Resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        className="group flex w-2 shrink-0 cursor-col-resize items-center justify-center bg-transparent outline-none"
        onPointerDown={onHandlePointerDown}
      >
        <div className="h-8 w-1 rounded-full bg-gray-300 opacity-0 transition-all duration-300 group-hover:h-12 group-hover:opacity-100" />
      </div>

      {/* Expanded panel (right) */}
      <div className="h-full min-w-0 flex-1">
        <ExpandedNodePanel />
      </div>
    </div>
  );
};
