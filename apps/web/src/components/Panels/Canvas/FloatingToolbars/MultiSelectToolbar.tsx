import { Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useMemo } from 'react';

import {
  ACCENT_NONE_TOKEN,
  ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
} from '@sediment/shared';
import {
  getSelectionBounds,
  getNodeSize,
  isAlwaysAutoHeightNodeType,
} from '@sediment/shared/canvas-engine';

import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
} from '@/components/Common/FloatingToolbar';
import { useIsNotMouse } from '@/hooks/useInputMode';
import useCanvasStore from '@/store/canvasStore';
import { useIntentStore } from '@/store/intentStore';
import { resolveGeometryEdit } from '@/utils/node/geometry';

import type { CanvasNode } from '@/components/Nodes/types';
import type { CanvasNodeId } from '@sediment/shared';

/** Sentinel token representing "no accent". */
const ACCENT_NONE = ACCENT_NONE_TOKEN;

interface GeometryToolbarItem {
  nodeId: CanvasNodeId;
  size: { width: number; height: number | undefined };
}

/**
 * A floating toolbar that appears horizontally centred above the
 * multi-selection bounding box when two or more nodes are selected.
 */
export const MultiSelectToolbar = () => {
  const nodes = useCanvasStore((s) => s.nodes);
  const alignSelectedNodes = useCanvasStore((s) => s.alignSelectedNodes);
  const spreadSelectedNodes = useCanvasStore((s) => s.spreadSelectedNodes);
  const executeCommands = useCanvasStore((s) => s.executeCommands);
  const setNodeGeometry = useCanvasStore((s) => s.setNodeGeometry);
  const setNoteHeightMode = useCanvasStore((s) => s.setNoteHeightMode);
  const beginGesture = useCanvasStore((s) => s.beginGesture);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const requestSketchRecognition = useIntentStore(
    (s) => s.requestSketchRecognition,
  );
  const isNotMouse = useIsNotMouse();

  const selectedNodes = useMemo(
    () => nodes.filter((n) => n.selected) as CanvasNode[],
    [nodes],
  );

  // Sketch (annotation) selections expose an `Apply Sketch` action that
  // hands the selected stroke ids to the vision-LLM recognition pipeline.
  // Shown only when *every* selected node is a sketch — mixing in regular
  // nodes would make the gesture's intent ambiguous.
  const sketchIds = useMemo(
    () =>
      selectedNodes.length > 0 &&
      selectedNodes.every((n) => n.type === 'sketch')
        ? selectedNodes.map((n) => n.id)
        : null,
    [selectedNodes],
  );

  // Determine the common accent among selected nodes (empty string if mixed)
  const commonAccent = useMemo(() => {
    if (selectedNodes.length === 0) return ACCENT_NONE;
    const first = selectedNodes[0].data?.style?.accent ?? null;
    const allSame = selectedNodes.every(
      (n) => (n.data?.style?.accent ?? null) === first,
    );
    return allSame ? (first ?? ACCENT_NONE) : ACCENT_NONE;
  }, [selectedNodes]);

  const textFlowSelection = useMemo(() => {
    if (selectedNodes.length === 0) return null;
    if (!selectedNodes.every((n) => isAlwaysAutoHeightNodeType(n.type ?? ''))) {
      return null;
    }
    const first = selectedNodes[0].data?.style?.fontSize ?? 16;
    const allSame = selectedNodes.every(
      (n) => Math.round(n.data?.style?.fontSize ?? 16) === Math.round(first),
    );
    return { fontSize: allSame ? first : null };
  }, [selectedNodes]);

  const hasTextFlowSelection = useMemo(
    () => selectedNodes.some((n) => isAlwaysAutoHeightNodeType(n.type ?? '')),
    [selectedNodes],
  );
  const hasBoxSelection = useMemo(
    () => selectedNodes.some((n) => !isAlwaysAutoHeightNodeType(n.type ?? '')),
    [selectedNodes],
  );
  const hasMixedTextAndBoxSelection = hasTextFlowSelection && hasBoxSelection;

  // Always include the "Transparent" swatch so users can revert a node
  // back to the default (no-accent / neutral surface) state. Hiding it
  // for non-text selections used to be the design (the assumption being
  // that other types "need a solid background"), but in practice every
  // node defaults to a null accent and the picker had no way to express
  // that state — once a coloured swatch was clicked it could not be
  // undone.
  const accentPickerOptions = ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT;

  // Common width / height across selected nodes. `null` when the
  // selected nodes do not all share the same value — the size picker
  // shows a "—" placeholder and the user can fill in either field to
  // apply just that dimension uniformly.
  const commonSize = useMemo(() => {
    if (selectedNodes.length === 0) return { width: null, height: null };
    const sizes = selectedNodes.map((n) => getNodeSize(n));
    const firstW = sizes[0].width;
    const firstH = sizes[0].height;
    const sameW =
      firstW > 0 &&
      sizes.every((s) => Math.round(s.width) === Math.round(firstW));
    const sameH =
      firstH > 0 &&
      sizes.every((s) => Math.round(s.height) === Math.round(firstH));
    return {
      width: sameW ? firstW : null,
      height: sameH ? firstH : null,
    };
  }, [selectedNodes]);

  // Note auto-fit toggle: only exposed when *every* selected node is a
  // note AND they all share the same auto/fixed state. Mixed states
  // would make a single toggle ambiguous, so we hide it instead.
  const noteAutoState = useMemo(() => {
    if (selectedNodes.length === 0) return null;
    if (!selectedNodes.every((n) => n.type === 'note')) return null;
    const firstAuto =
      (selectedNodes[0].style?.height as number | undefined) === undefined;
    const allSame = selectedNodes.every(
      (n) =>
        ((n.style?.height as number | undefined) === undefined) === firstAuto,
    );
    return allSame ? { active: firstAuto } : null;
  }, [selectedNodes]);

  // "Last pinned height" memory is owned by the shared `noteHeightMemory`
  // module (populated by `useTrackNoteFixedHeight` on each NoteNode), so
  // this toolbar doesn't need a parallel per-node map — `setNoteHeightMode`
  // reads from the same source whether the toggle was fired here, from the
  // single-select toolbar, or from the corner affordance.
  const toggleNotesAutoHeight = useCallback(() => {
    if (!noteAutoState) return;
    setNoteHeightMode(
      selectedNodes.map((n) => n.id),
      noteAutoState.active ? 'fixed' : 'auto',
    );
  }, [noteAutoState, selectedNodes, setNoteHeightMode]);

  // Compute bounding box of selected nodes in flow (absolute) coordinates.
  // Returned as a `CanvasFloatingPopover` anchor rect. Uses the shared
  // `getSelectionBounds` helper so the anchor stays in lock-step with
  // the multi-select resizer's outline.
  const anchor = useMemo(() => {
    if (selectedNodes.length < 2) return null;
    const bounds = getSelectionBounds(selectedNodes, nodes);
    if (!bounds) return null;
    return {
      x: bounds.minX,
      y: bounds.minY,
      width: bounds.width,
      height: bounds.height,
    };
  }, [selectedNodes, nodes]);

  return (
    <CanvasFloatingPopover
      anchor={anchor}
      open={selectedNodes.length >= 2}
      offset={12}
      side="top"
      className={FLOATING_TOOLBAR_CLASS}
    >
      {/* Align & distribute — collapsed into a single popover trigger
          to keep the multi-select toolbar compact. Houses the 6 align
          actions in a 3×2 grid plus the Spread Apart action. */}
      <FloatingToolbar.AlignPicker
        onAlign={(direction) => alignSelectedNodes(direction)}
        onSpread={() => spreadSelectedNodes()}
      />

      <FloatingToolbar.Divider />

      {/* Size editor: set width / height of every selected node. */}
      <FloatingToolbar.SizePicker
        width={commonSize.width}
        height={textFlowSelection ? null : commonSize.height}
        showHeight={!textFlowSelection && !hasMixedTextAndBoxSelection}
        onApply={({ width, height }) => {
          if (selectedNodes.length === 0) return;
          if (width === undefined && height === undefined) return;
          // Resolve per-node via the shared helper, which:
          //  - falls back to each node's existing width when only height
          //    was edited (and skips nodes whose width can't be resolved);
          //  - preserves each node's pinned-vs-auto height state when the
          //    user didn't enter a height.
          const items = selectedNodes
            .map((node): GeometryToolbarItem | null => {
              const resolved = resolveGeometryEdit(node, {
                width,
                height,
              });
              if (!resolved) return null;
              return {
                nodeId: node.id as CanvasNodeId,
                size: {
                  width: resolved.width,
                  height: resolved.height,
                },
              };
            })
            .filter((item): item is GeometryToolbarItem => item !== null);
          if (items.length === 0) return;
          // SET_NODE_GEOMETRY uses snapshot:'caller' — open a gesture so
          // the resize folds into one undo entry and the store doesn't warn.
          beginGesture('SET_NODE_GEOMETRY');
          setNodeGeometry(
            items.map(({ nodeId, size }) => ({
              nodeId,
              size,
            })),
          );
        }}
        heightAuto={
          noteAutoState
            ? {
                active: noteAutoState.active,
                onToggle: toggleNotesAutoHeight,
                title: noteAutoState.active
                  ? 'Switch to fixed height'
                  : 'Fit height to content',
              }
            : undefined
        }
      />

      {textFlowSelection && (
        <FloatingToolbar.NumberInput
          label="Font"
          ariaLabel="Font size"
          value={textFlowSelection.fontSize}
          min={8}
          max={160}
          onApply={(fontSize) => {
            executeCommands([
              {
                type: 'MERGE_NODE_DATA',
                patches: selectedNodes.map((node) => ({
                  nodeId: node.id as CanvasNodeId,
                  patch: {
                    style: { ...(node.data.style ?? {}), fontSize },
                  },
                })),
              },
            ]);
          }}
        />
      )}

      {sketchIds && (
        <>
          <FloatingToolbar.Divider />
          <FloatingToolbar.ActionButton
            title="Apply Sketch (interpret strokes with AI)"
            onClick={() => requestSketchRecognition(sketchIds)}
          >
            <Sparkles />
          </FloatingToolbar.ActionButton>
        </>
      )}

      <FloatingToolbar.Divider />

      {/* Accent color for all selected nodes */}
      <FloatingToolbar.ColorPicker
        colors={accentPickerOptions}
        value={commonAccent}
        onSelect={(t) => {
          const accent = t === ACCENT_NONE ? null : t;
          if (selectedNodes.length === 0) return;

          executeCommands([
            {
              type: 'MERGE_NODE_DATA',
              patches: selectedNodes.map((node) => ({
                nodeId: node.id as CanvasNodeId,
                patch: {
                  style: { ...node.data?.style, accent },
                },
              })),
            },
          ]);
        }}
        title="Accent Color"
      />

      {/* Non-mouse only: mouse users have keyboard Delete / Backspace. */}
      {isNotMouse && (
        <>
          <FloatingToolbar.Divider />
          <FloatingToolbar.ActionButton
            title="Delete Selected"
            tone="danger"
            onClick={() => {
              if (selectedNodes.length === 0) return;
              deleteNodes(selectedNodes.map((n) => n.id));
            }}
          >
            <Trash2 />
          </FloatingToolbar.ActionButton>
        </>
      )}
    </CanvasFloatingPopover>
  );
};
