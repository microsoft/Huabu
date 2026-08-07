// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
} from '@/components/Common/FloatingToolbar';
import { SketchControls } from '@/components/Nodes/sketch/SketchControls';
import { getSketchStrokeSelectionBounds } from '@/components/Nodes/sketch/sketchHitTest';
import {
  buildEraseCommands,
  commitStrokeCommands,
} from '@/components/Nodes/sketch/sketchMerge';
import {
  DEFAULT_STROKE_COLOR,
  DEFAULT_STROKE_SIZE,
} from '@/components/Nodes/sketch/sketchPath';
import { useIsNotMouse } from '@/hooks/useInputMode';
import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import type { CanvasSketchNodeData } from '@/components/Nodes/types';
import type { CanvasCommand, CanvasNodeId, SketchStroke } from '@huabu/shared';

/**
 * Floating toolbar for a Stage 2 stroke-level lasso selection. Aligns with
 * the sketch node's own controls: color + thickness edit the selected
 * strokes. Delete is **touch-only** (desktop uses the keyboard). Toolbar
 * arbitration guarantees at most one floating toolbar:
 *   - pure stroke selection → color + size (+ delete on touch);
 *   - mixed (strokes + nodes) → touch: delete only; desktop: nothing
 *     (node toolbars are suppressed while a stroke selection exists);
 *   - pure node selection → the node toolbars own the surface.
 */
export const StrokeSelectionToolbar = () => {
  const { t } = useTranslation();
  // Subscribe to `nodes` so the anchor + representative style track edits.
  const nodes = useCanvasStore((s) => s.nodes);
  const executeCommands = useCanvasStore((s) => s.executeCommands);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const beginNodeDataGesture = useCanvasStore((s) => s.beginNodeDataGesture);
  const endNodeDataGesture = useCanvasStore((s) => s.endNodeDataGesture);
  const selection = useGesturePreviewStore((s) => s.sketchStrokeSelection);
  const clearSelection = useGesturePreviewStore(
    (s) => s.clearSketchStrokeSelection,
  );
  const isNotMouse = useIsNotMouse();

  const hasSelection = Object.keys(selection).length > 0;
  const hasNodeSelection = nodes.some((n) => n.selected);
  const isMixed = hasSelection && hasNodeSelection;

  const anchor = useMemo(() => {
    if (!hasSelection) return null;
    void nodes; // recompute as sketches move / resize
    return getSketchStrokeSelectionBounds(selection);
  }, [selection, hasSelection, nodes]);

  // Representative color / size for the swatches: the first selected stroke.
  const { color, size } = useMemo(() => {
    for (const [nodeId, strokeIds] of Object.entries(selection)) {
      const node = nodes.find((n) => n.id === nodeId);
      const strokes = (node?.data as CanvasSketchNodeData | undefined)?.strokes;
      if (!strokes) continue;
      const idSet = new Set(strokeIds);
      const first = strokes.find((s) => idSet.has(s.id));
      if (first) {
        return {
          color: first.color ?? DEFAULT_STROKE_COLOR,
          size: first.size ?? DEFAULT_STROKE_SIZE,
        };
      }
    }
    return { color: DEFAULT_STROKE_COLOR, size: DEFAULT_STROKE_SIZE };
  }, [selection, nodes]);

  // Apply a per-stroke patch (color / size) to only the selected strokes.
  const patchSelected = useCallback(
    (patch: Partial<SketchStroke>) => {
      const patches: Extract<
        CanvasCommand,
        { type: 'MERGE_NODE_DATA' }
      >['patches'] = [];
      for (const [nodeId, strokeIds] of Object.entries(selection)) {
        const node = nodes.find((n) => n.id === nodeId);
        const strokes = (node?.data as CanvasSketchNodeData | undefined)
          ?.strokes;
        if (!strokes) continue;
        const idSet = new Set(strokeIds);
        patches.push({
          nodeId: nodeId as CanvasNodeId,
          patch: {
            strokes: strokes.map((s) =>
              idSet.has(s.id) ? { ...s, ...patch } : s,
            ),
          },
        });
      }
      if (patches.length > 0) {
        executeCommands([{ type: 'MERGE_NODE_DATA', patches }]);
      }
    },
    [selection, nodes, executeCommands],
  );

  const handleDelete = useCallback(() => {
    const strokeCommands: CanvasCommand[] = [];
    for (const [nodeId, strokeIds] of Object.entries(selection)) {
      if (strokeIds.length === 0) continue;
      strokeCommands.push(
        ...buildEraseCommands(nodeId as CanvasNodeId, new Set(strokeIds)),
      );
    }
    // Whole nodes the same lasso also selected are removed TOGETHER with the
    // strokes, as a single undo entry (mirrors the mixed stroke-move
    // gesture). Sketch nodes are never whole-node selected, so these are the
    // non-sketch members of a mixed selection.
    const selectedNodeIds = useCanvasStore
      .getState()
      .nodes.filter((n) => n.selected)
      .map((n) => n.id);
    clearSelection();
    if (selectedNodeIds.length > 0) {
      // Node delete takes its own snapshot + records the intent trace; fold
      // the stroke erase into that SAME undo entry.
      deleteNodes(selectedNodeIds);
      commitStrokeCommands(strokeCommands, { foldIntoOpenGesture: true });
    } else {
      commitStrokeCommands(strokeCommands);
    }
  }, [selection, clearSelection, deleteNodes]);

  // Keyboard delete: the delete button is touch-only, so desktop deletes
  // the stroke selection via Delete / Backspace. Coexists with React Flow's
  // node delete (a mixed selection removes both on one press).
  useEffect(() => {
    if (!hasSelection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable)
      ) {
        return;
      }
      handleDelete();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasSelection, handleDelete]);

  const showStyle = !isMixed; // style controls only for a pure stroke selection
  const showDelete = isNotMouse; // delete button is touch-only
  const open = hasSelection && anchor !== null && (showStyle || showDelete);

  return (
    <CanvasFloatingPopover
      anchor={anchor}
      open={open}
      offset={12}
      side="top"
      className={FLOATING_TOOLBAR_CLASS}
    >
      {showStyle && (
        <SketchControls
          color={color}
          size={size}
          touch={isNotMouse}
          onColorChange={(c) => patchSelected({ color: c })}
          onSizeChange={(s) => patchSelected({ size: s })}
          onSizeDragStart={beginNodeDataGesture}
          onSizeDragEnd={endNodeDataGesture}
        />
      )}
      {showStyle && showDelete && <FloatingToolbar.Divider />}
      {showDelete && (
        <FloatingToolbar.ActionButton
          title={t('toolbar.deleteSelected')}
          onClick={(e) => {
            e.stopPropagation();
            handleDelete();
          }}
        >
          <Trash2 />
        </FloatingToolbar.ActionButton>
      )}
    </CanvasFloatingPopover>
  );
};
