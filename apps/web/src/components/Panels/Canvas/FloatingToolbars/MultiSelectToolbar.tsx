import { Pin, PinOff, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ACCENT_NONE_TOKEN,
  ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
} from '@sediment/shared';
import {
  DEFAULT_EDGE_STROKE_TOKEN,
  getSelectionBounds,
  getNodeSize,
  isAlwaysAutoHeightNodeType,
  resolveHeightMode,
} from '@sediment/shared/canvas-engine';

import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
} from '@/components/Common/FloatingToolbar';
import { useIsNotMouse } from '@/hooks/useInputMode';
import { translateColorOptions } from '@/i18n/colors';
import useCanvasStore from '@/store/canvasStore';
import { useIntentStore } from '@/store/intentStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { resolveGeometryEdit } from '@/utils/node/geometry';
import { getEdgeIdsBetweenSelectedNodes } from '@/utils/selection';

import type { CanvasNode } from '@/components/Nodes/types';
import type { CanvasEdgeId, CanvasNodeId } from '@sediment/shared';

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
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const alignSelectedNodes = useCanvasStore((s) => s.alignSelectedNodes);
  const spreadSelectedNodes = useCanvasStore((s) => s.spreadSelectedNodes);
  const executeCommands = useCanvasStore((s) => s.executeCommands);
  const setNodeGeometry = useCanvasStore((s) => s.setNodeGeometry);
  const setNoteHeightMode = useCanvasStore((s) => s.setNoteHeightMode);
  const beginGesture = useCanvasStore((s) => s.beginGesture);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const canvasId = useCanvasStore((s) => s.canvasId);
  const setPortalNodePins = useCanvasStore((s) => s.setPortalNodePins);
  const worldCanvasId = useWorkspaceStore((s) => s.worldCanvasId);
  const worldEnabled = useWorkspaceStore((s) => s.worldEnabled);
  const pinnedSourceNodeIds = useCanvasStore((s) => s.pinnedSourceNodeIds);
  const requestSketchRecognition = useIntentStore(
    (s) => s.requestSketchRecognition,
  );
  const isNotMouse = useIsNotMouse();

  const selectedNodes = useMemo(
    () => nodes.filter((n) => n.selected) as CanvasNode[],
    [nodes],
  );
  const selectedNodeRefUpdates = useMemo(() => {
    const nodeIdsByCanvas = new Map<string, `node-${string}`[]>();
    for (const node of selectedNodes) {
      if (node.type !== 'nodeRef' && node.type !== 'frameRef') continue;
      const target = (
        node.data as {
          target: { canvasId: string; nodeId: string };
        }
      ).target;
      const nodeIds = nodeIdsByCanvas.get(target.canvasId) ?? [];
      nodeIds.push(target.nodeId as `node-${string}`);
      nodeIdsByCanvas.set(target.canvasId, nodeIds);
    }
    return [...nodeIdsByCanvas].map(([sourceCanvasId, sourceNodeIds]) => ({
      sourceCanvasId: sourceCanvasId as `canvas-${string}`,
      sourceNodeIds,
      pinned: false as const,
    }));
  }, [selectedNodes]);
  const canPinSourceSelection =
    worldEnabled &&
    canvasId !== worldCanvasId &&
    selectedNodes.length > 0 &&
    selectedNodes.every(
      (node) =>
        node.type !== 'canvasRef' &&
        node.type !== 'frameRef' &&
        node.type !== 'nodeRef',
    );
  // Pin state across the selection. When every node agrees the toolbar
  // collapses into one toggle; a mixed selection keeps both actions so
  // "pin all" and "unpin all" stay expressible.
  const sourcePinState = useMemo(() => {
    if (!canPinSourceSelection) return null;
    const pinnedCount = selectedNodes.filter(
      (node) => pinnedSourceNodeIds[node.id] === true,
    ).length;
    if (pinnedCount === 0) return 'none' as const;
    if (pinnedCount === selectedNodes.length) return 'all' as const;
    return 'mixed' as const;
  }, [canPinSourceSelection, pinnedSourceNodeIds, selectedNodes]);
  const pinSelection = useCallback(
    (pinned: boolean) =>
      void setPortalNodePins([
        {
          sourceCanvasId: canvasId as `canvas-${string}`,
          sourceNodeIds: selectedNodes.map(
            (node) => node.id as `node-${string}`,
          ),
          pinned,
        },
      ]),
    [canvasId, selectedNodes, setPortalNodePins],
  );
  const hasPortalSelection = selectedNodes.some(
    (node) => node.type === 'canvasRef',
  );
  const hasManagedSizeSelection = selectedNodes.some(
    (node) => node.type === 'canvasRef' || node.type === 'frameRef',
  );

  // Edges whose endpoints are both in the node selection participate in
  // multi-selection styling. This matches the derived edge highlighting in
  // Canvas without turning those edges into independently selected objects.
  const selectedInternalEdges = useMemo(() => {
    const edgeIds = new Set(
      getEdgeIdsBetweenSelectedNodes(
        selectedNodes.map((node) => node.id),
        edges,
      ),
    );
    return edges.filter((edge) => edgeIds.has(edge.id));
  }, [edges, selectedNodes]);

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
  const accentPickerOptions = useMemo(
    () => translateColorOptions(ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT, t),
    [t],
  );

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
    // Read ownership through the shared resolver: an auto note now
    // carries a materialized `style.height`, so the presence of a number
    // no longer distinguishes the two modes.
    const firstAuto = resolveHeightMode(selectedNodes[0]) === 'auto';
    const allSame = selectedNodes.every(
      (n) => (resolveHeightMode(n) === 'auto') === firstAuto,
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
      {!hasManagedSizeSelection && (
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
                }
              : undefined
          }
        />
      )}

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
            title={t('node.applySketchPlural')}
            onClick={() => requestSketchRecognition(sketchIds)}
          >
            <Sparkles />
          </FloatingToolbar.ActionButton>
        </>
      )}

      {sourcePinState && (
        <>
          <FloatingToolbar.Divider />
          {sourcePinState === 'mixed' ? (
            <>
              <FloatingToolbar.ActionButton
                title={t('world.pinSelected')}
                onClick={() => pinSelection(true)}
              >
                <Pin />
              </FloatingToolbar.ActionButton>
              <FloatingToolbar.ActionButton
                title={t('world.unpinSelected')}
                onClick={() => pinSelection(false)}
              >
                <PinOff />
              </FloatingToolbar.ActionButton>
            </>
          ) : (
            <FloatingToolbar.ToggleButton
              active={sourcePinState === 'all'}
              title={
                sourcePinState === 'all'
                  ? t('world.unpinSelected')
                  : t('world.pinSelected')
              }
              onClick={() => pinSelection(sourcePinState !== 'all')}
            >
              {sourcePinState === 'all' ? <PinOff /> : <Pin />}
            </FloatingToolbar.ToggleButton>
          )}
        </>
      )}

      {selectedNodeRefUpdates.length > 0 && (
        <>
          <FloatingToolbar.Divider />
          <FloatingToolbar.ActionButton
            title={t('world.unpinSelected')}
            onClick={() => void setPortalNodePins(selectedNodeRefUpdates)}
          >
            <PinOff />
          </FloatingToolbar.ActionButton>
        </>
      )}

      <FloatingToolbar.Divider />

      {/* Accent color for selected nodes and the edges between them. */}
      {!hasPortalSelection && (
        <FloatingToolbar.ColorPicker
          colors={accentPickerOptions}
          value={commonAccent}
          onSelect={(token) => {
            const accent = token === ACCENT_NONE ? null : token;
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
              ...(selectedInternalEdges.length > 0
                ? [
                    {
                      type: 'SET_EDGE_STYLE' as const,
                      edges: selectedInternalEdges.map((edge) => ({
                        edge: edge.id as CanvasEdgeId,
                        style: {
                          stroke: accent ?? DEFAULT_EDGE_STROKE_TOKEN,
                        },
                      })),
                    },
                  ]
                : []),
            ]);
          }}
          title={t('toolbar.accentColor')}
        />
      )}

      {/* Non-mouse only: mouse users have keyboard Delete / Backspace. */}
      {isNotMouse && (
        <>
          <FloatingToolbar.Divider />
          <FloatingToolbar.ActionButton
            title={t('toolbar.deleteSelected')}
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
