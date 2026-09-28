// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { findSketchStrokesInPolygon } from '@/components/Nodes/sketch/sketchHitTest';
import { nodesInSelection } from '@/components/Panels/Canvas/areaSelection';
import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import type { SelectionArea } from '@/utils/selectionGeometry';

function applySelection(nodeIds: string[], edgeIds: string[]) {
  const state = useCanvasStore.getState();
  const nodes = new Set(nodeIds);
  const edges = new Set(edgeIds);
  state.onNodesChange(
    state.nodes.flatMap((node) =>
      Boolean(node.selected) === nodes.has(node.id)
        ? []
        : [
            {
              id: node.id,
              type: 'select' as const,
              selected: nodes.has(node.id),
            },
          ],
    ),
  );
  state.onEdgesChange(
    state.edges.flatMap((edge) =>
      Boolean(edge.selected) === edges.has(edge.id)
        ? []
        : [
            {
              id: edge.id,
              type: 'select' as const,
              selected: edges.has(edge.id),
            },
          ],
    ),
  );
}

/** Live changes never create history; commit records once, cancellation restores the snapshot. */
export function createAreaSelectionSession(strokeLevel = false) {
  const initial = useCanvasStore.getState();
  const initialInk = useGesturePreviewStore.getState();
  const nodeIds = initial.nodes
    .filter((node) => node.selected)
    .map((node) => node.id);
  const edgeIds = initial.edges
    .filter((edge) => edge.selected)
    .map((edge) => edge.id);
  let changed = false;
  const sameCanvas = () =>
    useCanvasStore.getState().canvasId === initial.canvasId;
  return {
    preview(area: SelectionArea | null) {
      if (!sameCanvas()) return;
      changed = true;
      const state = useCanvasStore.getState();
      const candidates = strokeLevel
        ? state.nodes.filter((node) => node.type !== 'sketch')
        : state.nodes;
      // Keep ancestors in the geometry resolver, even when their Sketch ink is selected separately.
      const hits = area ? nodesInSelection(state.nodes, area) : [];
      const eligible = new Set(candidates.map((node) => node.id));
      const selected = hits.filter((id) => eligible.has(id));
      const selectedSet = new Set(selected);
      applySelection(
        selected,
        state.edges
          .filter(
            (edge) =>
              !edge.hidden &&
              edge.selectable !== false &&
              (selectedSet.has(edge.source) || selectedSet.has(edge.target)),
          )
          .map((edge) => edge.id),
      );
      if (strokeLevel) {
        const preview = useGesturePreviewStore.getState();
        preview.clearSketchStrokeHighlight();
        preview.setSketchStrokeSelection(
          area?.kind === 'polygon'
            ? findSketchStrokesInPolygon(area.points)
            : {},
        );
        preview.setSketchSelectionPolygon(null);
      }
    },
    commit(area: SelectionArea | null) {
      if (!sameCanvas()) return;
      this.preview(area);
      const state = useCanvasStore.getState();
      const selected = state.nodes
        .filter((node) => node.selected)
        .map((node) => node.id);
      if (strokeLevel) {
        const preview = useGesturePreviewStore.getState();
        const hasSelection =
          selected.length > 0 ||
          Object.keys(preview.sketchStrokeSelection).length > 0;
        preview.setSketchSelectionPolygon(
          hasSelection && area?.kind === 'polygon' ? [...area.points] : null,
        );
      }
      state.selectNodes(selected);
    },
    cancel() {
      if (!changed || !sameCanvas()) return;
      applySelection(nodeIds, edgeIds);
      if (strokeLevel) {
        useGesturePreviewStore.setState({
          sketchStrokeSelection: initialInk.sketchStrokeSelection,
          sketchSelectionPolygon: initialInk.sketchSelectionPolygon,
          sketchStrokeHighlight: initialInk.sketchStrokeHighlight,
        });
      }
    },
  };
}
