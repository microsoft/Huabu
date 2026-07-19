import { Trash2 } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
} from '@/components/Common/FloatingToolbar';
import { getSketchStrokeSelectionBounds } from '@/components/Nodes/sketch/sketchHitTest';
import { buildEraseCommands } from '@/components/Nodes/sketch/sketchMerge';
import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import type { CanvasCommand, CanvasNodeId } from '@sediment/shared';

/**
 * Floating toolbar for a Stage 2 stroke-level lasso selection. Anchored
 * above the union bbox of the selected strokes; currently exposes a
 * single Delete action (rendering to PNG / send-to-AI is deferred to
 * Stage 3). Selection lives in `gesturePreviewStore.sketchStrokeSelection`
 * (`nodeId -> strokeIds`) and is produced by the Canvas lasso consumer.
 */
export const StrokeSelectionToolbar = () => {
  const { t } = useTranslation();
  // Subscribe to `nodes` too so the anchor tracks a selected sketch that
  // gets moved / resized while its strokes stay selected.
  const nodes = useCanvasStore((s) => s.nodes);
  const executeCommands = useCanvasStore((s) => s.executeCommands);
  const beginGesture = useCanvasStore((s) => s.beginGesture);
  const selection = useGesturePreviewStore((s) => s.sketchStrokeSelection);
  const clearSelection = useGesturePreviewStore(
    (s) => s.clearSketchStrokeSelection,
  );

  const hasSelection = Object.keys(selection).length > 0;

  // Guarantee at most one floating toolbar: when any node is selected the
  // node toolbars own the surface, so the stroke delete bar steps aside
  // (the strokes stay highlighted; this only affects the rare mixed lasso).
  const hasNodeSelection = nodes.some((n) => n.selected);

  const anchor = useMemo(() => {
    if (!hasSelection) return null;
    // `nodes` is an explicit dep so the bbox recomputes as sketches move.
    void nodes;
    return getSketchStrokeSelectionBounds(selection);
  }, [selection, hasSelection, nodes]);

  const handleDelete = useCallback(() => {
    const commands: CanvasCommand[] = [];
    for (const [nodeId, strokeIds] of Object.entries(selection)) {
      if (strokeIds.length === 0) continue;
      commands.push(
        ...buildEraseCommands(nodeId as CanvasNodeId, new Set(strokeIds)),
      );
    }
    clearSelection();
    if (commands.length === 0) return;

    // `SET_NODE_GEOMETRY` uses snapshot:'caller' — take the undo snapshot
    // now so stroke removal + geometry reflow fold into one undo entry
    // (mirrors the eraser's commit in SketchOverlay).
    if (commands.some((c) => c.type === 'SET_NODE_GEOMETRY')) {
      beginGesture('SET_NODE_GEOMETRY');
    }
    executeCommands(commands, 'ui');
  }, [selection, clearSelection, beginGesture, executeCommands]);

  return (
    <CanvasFloatingPopover
      anchor={anchor}
      open={hasSelection && anchor !== null && !hasNodeSelection}
      offset={12}
      side="top"
      className={FLOATING_TOOLBAR_CLASS}
    >
      <FloatingToolbar.ActionButton
        title={t('toolbar.deleteSelected')}
        onClick={(e) => {
          e.stopPropagation();
          handleDelete();
        }}
      >
        <Trash2 />
      </FloatingToolbar.ActionButton>
    </CanvasFloatingPopover>
  );
};
