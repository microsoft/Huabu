// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  ConnectionMode,
  SelectionMode,
  useStore,
  type ReactFlowInstance,
  type Connection,
  type Edge,
  Panel,
} from '@xyflow/react';
import clsx from 'clsx';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import '@xyflow/react/dist/style.css';

import {
  assignNodeZIndices,
  edgeZIndex,
  indexById,
} from '@huabu/shared/canvas-engine';

import { resolveArtifactUrl } from '@/api/artifact';
import { cn } from '@/components/Common/cn';
import { Loading } from '@/components/Common/Loading';
import { AudioNode } from '@/components/Nodes/audio/AudioNode';
import {
  FrameZoomController,
  FrameZoomProvider,
} from '@/components/Nodes/frame/FrameZoomContext';
import { ImageNode } from '@/components/Nodes/image/ImageNode';
import {
  sideFromHandleId,
  useCreateConnectedNode,
  type ConnectedNodeKind,
} from '@/components/Nodes/NodeConnectAffordance.tsx';
import { NoteNode } from '@/components/Nodes/note/NoteNode';
import { OfficeNode } from '@/components/Nodes/office/OfficeNode';
import { PDFNode } from '@/components/Nodes/pdf/PDFNode';
import {
  cancelHeightCommitSuspensions,
  resumeHeightCommits,
  suspendHeightCommits,
} from '@/components/Nodes/shared/height/commitSuspension';
import { destroyOffscreenMeasurer } from '@/components/Nodes/shared/height/measure/offscreenMeasurer';
import {
  startHeightPrewarm,
  stopHeightPrewarm,
} from '@/components/Nodes/shared/height/measure/prewarmQueue';
import { TextNode } from '@/components/Nodes/text/TextNode';
import {
  uploadFileToNodeInput,
  urlToNodeInput,
  textToNoteNodeInput,
} from '@/handler/canvasCommand/nodeInputBuilders';
import { getDragActivationDistance } from '@/handler/canvasGestureSession';
import { createHandlerOwnerRecognizer } from '@/handler/canvasPointerRecognizers/handlerOwner';
import { createPlacementRecognizer } from '@/handler/canvasPointerRecognizers/placement';
import { useCanvasShortcuts } from '@/hooks/shortcuts';
import { isOutsideCanvasInteraction } from '@/hooks/shortcuts/isEditableTarget';
import { useAutoPanDuringSelection } from '@/hooks/useAutoPanDuringSelection';
import { useCanvasFocusEscape } from '@/hooks/useCanvasFocusEscape';
import { useCanvasGestures } from '@/hooks/useCanvasGestures';
import { useCanvasLasso } from '@/hooks/useCanvasLasso';
import { useCanvasMarquee } from '@/hooks/useCanvasMarquee';
import { useCanvasPanReleaseGuard } from '@/hooks/useCanvasPanReleaseGuard';
import { useCanvasPointerRouter } from '@/hooks/useCanvasPointerRouter';
import { useFrameDragToCreate } from '@/hooks/useFrameDragToCreate';
import {
  useEffectiveInputMode,
  useInputMode,
  useIsNotMouse,
} from '@/hooks/useInputMode';
import { useSketchHoverRouting } from '@/hooks/useSketchHoverRouting';
import { useSketchStrokeMove } from '@/hooks/useSketchStrokeMove';
import { openPreviewNode } from '@/store/previewWorkspace/actions';
import { isMac } from '@/utils/platform';
import { getEdgeIdsBetweenSelectedNodes } from '@/utils/selection';

import { applyNodeGeometryPreviews } from './applyNodeGeometryPreview';
import { CanvasGrid } from './CanvasGrid';
import {
  canStartRetainedSelectionMove,
  canDirectlyManipulateWithPointer,
  closestNodeElement,
  isLassoStartTarget,
  isPanelTarget,
  resolveNodeDraggable,
} from './canvasInputPolicy.ts';
import { NodeToolbar } from './CanvasToolbar.tsx';
import { CanvasZoomMenu } from './CanvasZoomMenu';
import { ConnectedNodePicker } from './ConnectedNodePicker.tsx';
import {
  EDIT_EDGE_LABEL_EVENT,
  LabelledEdge,
  type EditEdgeLabelDetail,
} from './edges/LabelledEdge.tsx';
import { EdgeStyleToolbar } from './FloatingToolbars/EdgeStyleToolbar.tsx';
import { MultiSelectToolbar } from './FloatingToolbars/MultiSelectToolbar.tsx';
import { StrokeSelectionToolbar } from './FloatingToolbars/StrokeSelectionToolbar.tsx';
import { MoveSelectionModal } from './MoveSelectionModal.tsx';
import { MultiSelectResizer } from './MultiSelectResizer.tsx';
import { SelectionOutlines } from './SelectionOutlines.tsx';
import { selectionZOrder, withoutNodeStyleZIndex } from './selectionZOrder';
import { SnapGuidesOverlay } from './SnapGuidesOverlay.tsx';
import { StrokeSelectionRegion } from './StrokeSelectionRegion.tsx';
import { StructuredDropOverlay } from './StructuredDropOverlay.tsx';
import { useInitialCanvasViewport } from './useInitialCanvasViewport.ts';
import { MAX_ZOOM, MIN_ZOOM } from '../../../config/canvas.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import { useConnectPortStore } from '../../../store/connectPortStore.ts';
import { useGesturePreviewStore } from '../../../store/gesturePreviewStore.ts';
import { useToolStore } from '../../../store/toolStore.ts';
import {
  canMoveHuabuPayload,
  canReadHuabuPayload,
  getHuabuPayload,
} from '../../../utils/io/dragDrop.ts';
import { looksLikeUrl } from '../../../utils/io/media.ts';
import { FrameNode } from '../../Nodes/frame/FrameNode.tsx';
import { createQuestionNodeAndCompose } from '../../Nodes/question/questionCompose.ts';
import { QuestionNode } from '../../Nodes/question/QuestionNode.tsx';
import { isPointInFlowPolygon } from '../../Nodes/sketch/sketchHitTest.ts';
import { SketchNode } from '../../Nodes/sketch/SketchNode.tsx';
import {
  CANCEL_SKETCH_GESTURE_EVENT,
  SketchOverlay,
} from '../../Nodes/sketch/SketchOverlay.tsx';
import { SpacePreviewNode } from '../../Nodes/spacePreview/SpacePreviewNode.tsx';
import { VideoNode } from '../../Nodes/video/VideoNode.tsx';
import { WebNode } from '../../Nodes/web/WebNode.tsx';
import { anchorViewportCentre } from '../CanvasLayerPanel/focusNodesOnCanvas.ts';

import type { CanvasNode } from '@/components/Nodes/types';
import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';
import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { PointerRecognizer } from '@/handler/pointerRouter';
import type { FrameFitResult, NestableNode } from '@huabu/shared/canvas-engine';

const nodeTypes = {
  image: ImageNode,
  text: TextNode,
  note: NoteNode,
  video: VideoNode,
  audio: AudioNode,
  web: WebNode,
  pdf: PDFNode,
  office: OfficeNode,
  frame: FrameNode,
  spacePreview: SpacePreviewNode,
  sketch: SketchNode,
  question: QuestionNode,
} as const;

/**
 * Override every React Flow edge type with our single `LabelledEdge`
 * component. Doing so for the built-in names (`default` / `straight` /
 * `smoothstep`) — not just our own `labelled` key — means edges loaded
 * from disk that pre-date this change still render with the editable
 * HTML label, because `applyEdgeStyle` historically stamped one of
 * those built-in type names onto each edge. The actual line shape is
 * picked inside the component from `data.edgeStyle.lineType`.
 */
const edgeTypes = {
  default: LabelledEdge,
  straight: LabelledEdge,
  smoothstep: LabelledEdge,
  step: LabelledEdge,
} as const;

/**
 * Renders a dashed-border preview overlay showing the target frame size
 * when a node is being dragged near or inside a frame.
 */
const FrameFitPreviewOverlay: React.FC<{
  preview: FrameFitResult;
  rfInstance: ReactFlowInstance | null;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
}> = React.memo(({ preview, rfInstance, wrapperRef }) => {
  const screenRect = useMemo(() => {
    if (!rfInstance || !wrapperRef.current) return null;

    const topLeft = rfInstance.flowToScreenPosition({
      x: preview.position.x,
      y: preview.position.y,
    });
    const bottomRight = rfInstance.flowToScreenPosition({
      x: preview.position.x + preview.width,
      y: preview.position.y + preview.height,
    });

    // Convert from screen coords to wrapper-relative coords
    const wrapperRect = wrapperRef.current.getBoundingClientRect();
    return {
      left: topLeft.x - wrapperRect.left,
      top: topLeft.y - wrapperRect.top,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }, [preview, rfInstance, wrapperRef]);

  if (!screenRect) return null;

  return (
    <div
      data-canvas-grounding-exclude
      className="bg-info-bg/40 shadow-bottom pointer-events-none absolute z-40 transition-all duration-150"
      style={{
        left: screenRect.left,
        top: screenRect.top,
        width: screenRect.width,
        height: screenRect.height,
      }}
    />
  );
});

/** Node types that support expand-on-double-click. */
const EXPANDABLE_TYPES = new Set([
  'image',
  'video',
  'web',
  'pdf',
  'office',
  'note',
]);

/**
 * Viewport corrections below this many screen pixels are dropped. Integer
 * `clientWidth` versus fractional `contentRect`, and fractional layout
 * widths, produce sub-pixel deltas that are invisible but still round-trip
 * through `onMoveEnd` and dirty the persisted viewport.
 */
const VIEWPORT_CORRECTION_EPSILON_PX = 0.5;

/**
 * `--color-info` is a design-system token that does not change at runtime,
 * but `getComputedStyle(document.documentElement).getPropertyValue(...)`
 * is a synchronous style read that can flush pending style work — and the
 * old `displayEdges` memo invoked it on every selection change. Cache the
 * resolved value lazily so subsequent renders pay nothing.
 */
let cachedInfoColor: string | null = null;
function getInfoColor(): string {
  if (cachedInfoColor !== null) return cachedInfoColor;
  if (typeof document === 'undefined') return '';
  cachedInfoColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-info')
    .trim();
  return cachedInfoColor;
}

/**
 * Inner component that owns canvas-wide touch / trackpad gesture wiring.
 * Lives inside `<ReactFlow>` so the gesture hook (which calls
 * `useStoreApi`) can reach React Flow's store context.
 */
const CanvasGestures: React.FC<{
  wrapperRef: React.MutableRefObject<HTMLDivElement | null>;
  rfInstanceRef: React.MutableRefObject<ReactFlowInstance | null>;
  inputMode: 'mouse' | 'pen' | 'finger';
  explicitToolActive: boolean;
  mouseMarqueeEnabled: boolean;
  canvasId: string | null;
  onMarqueeActiveChange: (active: boolean) => void;
  onTouchTakeover: () => void;
  onEmptyCanvasTap: () => void;
  onNodeTap: (nodeId: string) => void;
  extraRecognizers: PointerRecognizer<
    PointerEvent,
    CanvasPointerRouterContext
  >[];
}> = ({
  wrapperRef,
  rfInstanceRef,
  inputMode,
  explicitToolActive,
  mouseMarqueeEnabled,
  canvasId,
  onMarqueeActiveChange,
  onTouchTakeover,
  onEmptyCanvasTap,
  onNodeTap,
  extraRecognizers,
}) => {
  useCanvasGestures(wrapperRef, rfInstanceRef);
  const marquee = useCanvasMarquee({
    enabled: mouseMarqueeEnabled,
    scopeKey: canvasId,
    wrapperRef,
    rfInstanceRef,
    onActiveChange: onMarqueeActiveChange,
  });
  const recognizers = useMemo(
    () => [...extraRecognizers, marquee.recognizer],
    [extraRecognizers, marquee.recognizer],
  );
  useCanvasPointerRouter(
    wrapperRef,
    rfInstanceRef,
    {
      inputMode,
      explicitToolActive,
      onTouchTakeover: () => {
        marquee.cancel();
        onTouchTakeover();
      },
      onEmptyCanvasTap,
      onNodeTap,
    },
    recognizers,
  );
  return null;
};

/**
 * Inner component that drives auto-pan while the user is dragging out a
 * selection (built-in marquee or custom lasso). Mounted inside `<ReactFlow>`
 * so `useAutoPanDuringSelection` can reach React Flow's store via
 * `useStoreApi`.
 */
const SelectionAutoPan: React.FC<{
  active: boolean;
  wrapperRef: React.MutableRefObject<HTMLDivElement | null>;
  onPan: (dx: number, dy: number) => void;
}> = ({ active, wrapperRef, onPan }) => {
  useAutoPanDuringSelection({ active, wrapperRef, onPan });
  return null;
};

type CanvasProps = {
  shortcutsDisabled?: boolean;
};

export const Canvas: React.FC<CanvasProps> = (props) => {
  const { nodes, edges } = useCanvasStore.getState();
  return (
    <ReactFlowProvider
      initialNodes={nodes}
      initialEdges={edges}
      initialMinZoom={MIN_ZOOM}
      initialMaxZoom={MAX_ZOOM}
      zIndexMode="manual"
    >
      <CanvasContent {...props} />
    </ReactFlowProvider>
  );
};

const CanvasContent: React.FC<CanvasProps> = ({
  shortcutsDisabled = false,
}) => {
  // ── Reactive state subscriptions ─────────────────────────────
  // Only fields that actually change at runtime are subscribed. Anything
  // else (action fns) is read non-reactively below to avoid registering
  // a dedicated `useStore` subscription per accessor on mount — the
  // canvas component used to install ~16 of them just for stable
  // action refs, which dominated initial commit work on canvas open.
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const canvasId = useCanvasStore((state) => state.canvasId);
  const minimapEnabled = useCanvasStore((state) => state.minimapEnabled);
  const pendingNodeType = useToolStore((state) => state.pendingNodeType);
  // Whether a stroke-level sketch selection is active — suppresses node
  // toolbars so a mixed lasso never shows them (boolean selector).
  const hasStrokeSelection = useGesturePreviewStore(
    (s) => Object.keys(s.sketchStrokeSelection).length > 0,
  );
  // True while a stroke-move drag is in progress — drives the wrapper's
  // grabbing cursor (the pointer is captured by the router during the drag,
  // so the region element's own cursor no longer applies). Uses `grabbing`
  // to match node drag and canvas pan, since all three are "move a grabbed
  // object" gestures.
  const isStrokeMoving = useGesturePreviewStore(
    (s) => s.sketchStrokeMovePreview !== null,
  );
  const frameFitPreviews = useGesturePreviewStore(
    (state) => state.frameFitPreviews,
  );
  // Enables the peer slide-aside transition while a node hovers a
  // structured frame. Toggles once per hover (not per drag tick), and the
  // CSS rule excludes `.dragging` so the dragged node stays on the cursor.
  const isStructuredReflowing = useGesturePreviewStore(
    (state) => state.structuredDropPreview !== null,
  );
  const nodeGeometryPreviews = useGesturePreviewStore(
    (state) => state.nodeGeometryPreviews,
  );

  // ── Non-reactive action handles ──────────────────────────────
  // Action functions are defined once in the Zustand `create()` factory
  // and never change identity, so reading them via `getState()` yields
  // the same ref every render — useCallback / useEffect deps still
  // match across renders, but the subscription bookkeeping cost on
  // canvas mount drops to zero.
  const {
    onNodesChange,
    onEdgesChange,
    onConnect,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    endActiveDragSession,
    addNode,
    addNodes,
    moveNoteExcerpt,
    setRfInstance,
    setCanvasWrapper,
    setViewport,
    frameNodesInRect,
    selectNodes,
  } = useCanvasStore.getState();
  const { setPendingNodeType } = useToolStore.getState();

  const isBoxSelecting = useStore((state) => state.userSelectionActive);
  // The custom marquee owns auto-pan; native selection must not run it twice.
  const [isMouseMarqueeSelecting, setIsMouseMarqueeSelecting] = useState(false);

  const selectedNodeIds = useMemo(
    () => new Set(nodes.filter((node) => node.selected).map((node) => node.id)),
    [nodes],
  );
  const selectedEdgeIdSet = useMemo(
    () =>
      new Set(
        getEdgeIdsBetweenSelectedNodes(Array.from(selectedNodeIds), edges),
      ),
    [edges, selectedNodeIds],
  );

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setToolbarHost(
      wrapperRef.current
        ?.closest('[data-overlay-layout]')
        ?.querySelector<HTMLElement>('[data-canvas-toolbar-layer]') ?? null,
    );
  }, []);
  useCanvasFocusEscape(wrapperRef);
  const suppressNextPaneClickRef = useRef(false);
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);
  const lastDropRef = useRef<{ key: string; at: number } | null>(null);
  const mousePositionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const {
    defaultViewport,
    fitInitialViewport,
    isPending: isInitialViewportPending,
  } = useInitialCanvasViewport();

  const isNotMouse = useIsNotMouse();
  const inputMode = useEffectiveInputMode();
  const lastPointer = useInputMode();
  const inkSubmissionPreparing = useGesturePreviewStore(
    (state) => state.inkSubmissionPreparing,
  );

  // Keyboard shortcuts + paste handler (extracted to hook).
  // Also manages tool state (select/pan) and Space-key temporary pan.
  const { tool, setTool } = useCanvasShortcuts(
    {
      rfInstanceRef,
      mousePositionRef,
    },
    {
      disabled: shortcutsDisabled,
    },
  );
  useCanvasPanReleaseGuard(wrapperRef, !isNotMouse && tool === 'pan');

  const mouseMarqueeEnabled = !pendingNodeType && tool === 'select';

  // Tap-vs-drag activation follows the pointer actually in use.
  const dragActivationDistance = isNotMouse
    ? getDragActivationDistance(lastPointer === 'pen' ? 'pen' : 'touch')
    : getDragActivationDistance('mouse');

  useEffect(() => {
    if (isNotMouse && tool === 'pan') setTool('select');
  }, [isNotMouse, setTool, tool]);

  // Measure notes the user has not reached yet. `onlyRenderVisibleElements`
  // unmounts offscreen nodes, so this is the only way an unvisited note
  // ever gets a real footprint — without it, arriving at one produces a
  // visible (if bounded) correction.
  useEffect(() => {
    startHeightPrewarm();
    return () => {
      stopHeightPrewarm();
      void destroyOffscreenMeasurer();
    };
  }, []);

  // Sync the box-selected nodes back through the standard SELECT_NODES intent
  // so action history and event buffer stay in step with the visible selection.
  const handleSelectionEnd = useCallback(() => {
    if (tool !== 'select') return;
    selectNodes(nodes.filter((n) => n.selected).map((n) => n.id));
  }, [nodes, selectNodes, tool]);

  // Pending "create a connected node" gesture: geometry is already
  // resolved, only the node type is still missing. Held in a store rather
  // than local state because every node's ports read it too (see
  // `connectPortStore`).
  const connectPicker = useConnectPortStore((s) => s.pending);
  const setConnectPicker = useConnectPortStore((s) => s.setPending);
  const createConnectedNode = useCreateConnectedNode();

  // A pending gesture belongs to the mounted canvas; leaving the page (or
  // swapping canvases) must not leave a picker armed against a node that
  // is no longer on screen.
  useEffect(() => () => setConnectPicker(null), [setConnectPicker]);

  // Reject self-connections (an edge whose source and target are the same
  // node). React Flow uses this both to show the in-progress connection
  // line as invalid and to suppress the `onConnect` callback, so a
  // self-loop can never be created by dragging onto the node's own handle.
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => connection.source !== connection.target,
    [],
  );

  // Every connect gesture that React Flow did not resolve itself lands
  // here, and the release point decides what it meant:
  //
  //   - over another node  -> connect the two nodes (React Flow only
  //     accepts drops on a handle, so this also makes connecting far
  //     easier on touch devices);
  //   - over empty canvas  -> create a connected node right there;
  //   - back on the source node -> this is what a plain *click* on a
  //     port produces (press and release without moving), so auto-place
  //     the new node off that port's side.
  //
  // The last two only pick the geometry; `ConnectedNodePicker` then asks
  // for the node type. Folding "create" into the ports is what let the
  // four side arrows go away.
  const onConnectEnd = useCallback(
    (
      event: MouseEvent | TouchEvent,
      connectionState: {
        fromNode?: { id: string } | null;
        fromHandle?: { id?: string | null } | null;
        isValid: boolean | null;
      },
    ) => {
      // If React Flow already handled this as a valid connection, skip.
      if (connectionState.isValid) return;

      const sourceNodeId = connectionState.fromNode?.id;
      if (!sourceNodeId) return;

      const releasePoint =
        event instanceof TouchEvent
          ? {
              x: event.changedTouches[0].clientX,
              y: event.changedTouches[0].clientY,
            }
          : { x: event.clientX, y: event.clientY };

      // Determine the element under the pointer
      const target =
        event instanceof TouchEvent
          ? document.elementFromPoint(releasePoint.x, releasePoint.y)
          : (event.target as Element);

      const targetNodeId =
        closestNodeElement(target)?.getAttribute('data-id') ?? null;

      if (targetNodeId && targetNodeId !== sourceNodeId) {
        onConnect({
          source: sourceNodeId,
          target: targetNodeId,
          sourceHandle: null,
          targetHandle: null,
        });
        return;
      }

      const instance = rfInstanceRef.current;
      if (!instance) return;
      const anchor = instance.screenToFlowPosition(releasePoint);
      const side = sideFromHandleId(connectionState.fromHandle?.id);
      if (!side) return;

      setConnectPicker({
        sourceId: sourceNodeId,
        side,
        anchor,
        kind: targetNodeId === sourceNodeId ? 'side' : 'point',
      });
    },
    [onConnect, setConnectPicker],
  );

  const handleConnectedKindPick = useCallback(
    (nodeKind: ConnectedNodeKind) => {
      // Read-then-act rather than acting inside a `setState` updater:
      // updaters must be pure, and React double-invokes them in
      // StrictMode — which would create the node twice.
      const pending = useConnectPortStore.getState().pending;
      if (!pending) return;
      setConnectPicker(null);
      createConnectedNode(
        pending.sourceId,
        pending.kind === 'side'
          ? { kind: 'side', side: pending.side }
          : { kind: 'point', point: pending.anchor },
        nodeKind,
      );
    },
    [createConnectedNode, setConnectPicker],
  );

  const dismissConnectPicker = useCallback(
    () => setConnectPicker(null),
    [setConnectPicker],
  );

  // --- Frame drag-to-create gesture (mouse / pen / touch) ---
  const exitPendingNodeType = useCallback(
    () => setPendingNodeType(null),
    [setPendingNodeType],
  );
  const { pointerHandlers: framePointerHandlers, previewRect: frameDragRect } =
    useFrameDragToCreate({
      active: pendingNodeType === 'frame',
      wrapperRef,
      rfInstanceRef,
      onCreate: frameNodesInRect,
      onEnd: exitPendingNodeType,
    });

  const {
    pointerHandlers: lassoPointerHandlers,
    previewPath: lassoPreviewPath,
    isActive: isLassoActive,
    shiftScreenPoints: shiftLassoScreenPoints,
    cancel: cancelLasso,
  } = useCanvasLasso({
    active: !pendingNodeType && tool === 'lasso',
    scopeKey: canvasId,
    wrapperRef,
    rfInstanceRef,
    inputMode,
  });

  // Sketch hover routing: hit-test the cursor against painted strokes so
  // clicks on the blank area of an upper sketch's bounding box drill
  // through to whatever is below. Disabled while the sketch tool is
  // active (the SketchOverlay owns all pointer input then) or while
  // box-selecting, where ReactFlow needs the default selection box.
  useSketchHoverRouting(wrapperRef, rfInstanceRef, {
    enabled:
      pendingNodeType !== 'sketch' && tool !== 'lasso' && !isBoxSelecting,
  });
  // Stage 2: a stroke-level selection only makes sense under the Lasso
  // tool (where it is produced and its delete toolbar shows). Drop it the
  // moment the tool changes so the highlight + toolbar don't linger.
  useEffect(() => {
    if (tool !== 'lasso' && !inkSubmissionPreparing) {
      useGesturePreviewStore.getState().clearSketchStrokeSelection();
    }
  }, [inkSubmissionPreparing, tool]);
  const handleTouchTakeover = useCallback(() => {
    cancelLasso();
    window.dispatchEvent(new Event(CANCEL_SKETCH_GESTURE_EVENT));
  }, [cancelLasso]);
  // Forest order remains authoritative at rest. Sole selection temporarily
  // raises a node/subtree (including its actual in-node controls), without
  // changing store order or persisted z. Manual mode uses this map verbatim.
  const nodesById = useMemo(() => indexById(nodes as NestableNode[]), [nodes]);
  const zByNode = useMemo(
    () =>
      selectionZOrder(
        nodes as NestableNode[],
        assignNodeZIndices(nodes as NestableNode[]),
      ),
    [nodes],
  );

  // Cache of the wrapped node objects emitted last render, keyed by their
  // SOURCE node ref. Selection toggles only swap the toggled nodes' refs
  // (see `setNodeSelection`), so reusing the prior wrapped ref for every
  // untouched node keeps xyflow's per-node `React.memo` intact.
  const zWrapCacheRef = useRef<
    Map<(typeof nodes)[number], (typeof nodes)[number]>
  >(new Map());

  const displayNodes = useMemo<typeof nodes>(() => {
    const prevCache = zWrapCacheRef.current;
    const nextCache = new Map<(typeof nodes)[number], (typeof nodes)[number]>();

    const previewNodes = applyNodeGeometryPreviews(
      nodes as CanvasNode[],
      nodeGeometryPreviews,
    );
    const previewById = new Map(previewNodes.map((node) => [node.id, node]));
    const result = nodes.map((node) => {
      const z = zByNode.get(node.id) ?? 0;
      // Transient slide-aside offset; absent for every node outside the
      // hovered structured frame, and for the dragged node itself.
      const previewedNode = previewById.get(node.id) ?? node;
      const nextPosition = previewedNode.position;
      const nextStyle = withoutNodeStyleZIndex(previewedNode.style);
      const nextMeasured = previewedNode.measured;
      const touchDraggable = resolveNodeDraggable(
        node.draggable,
        node.selected,
        isNotMouse,
        lastPointer === 'touch' && node.type === 'sketch',
      );

      const cached = prevCache.get(node);
      if (
        cached &&
        cached.zIndex === z &&
        cached.draggable === touchDraggable &&
        cached.position === nextPosition &&
        cached.style === nextStyle &&
        cached.measured === nextMeasured
      ) {
        nextCache.set(node, cached);
        return cached;
      }

      const needsWrap =
        node.zIndex !== z ||
        node.draggable !== touchDraggable ||
        nextPosition !== node.position ||
        nextStyle !== node.style ||
        nextMeasured !== node.measured;
      const wrapped = needsWrap
        ? {
            ...node,
            zIndex: z,
            draggable: touchDraggable,
            position: nextPosition,
            style: nextStyle,
            measured: nextMeasured,
          }
        : node;
      nextCache.set(node, wrapped);
      return wrapped;
    });

    zWrapCacheRef.current = nextCache;
    return result;
  }, [isNotMouse, lastPointer, nodes, nodeGeometryPreviews, zByNode]);

  // Override marker colors on selected edges so arrows match the selection
  // highlight color (--color-info). CSS cannot style SVG <marker> referenced
  // via url() from <defs>, so we swap the marker config in JS. Also folds in
  // the manual-mode edge z (see `edgeZIndex`): under `zIndexMode="manual"`
  // React Flow paints edges at `edge.zIndex` verbatim, so we must assign the
  // "float above the endpoints' frame" value ourselves (auto mode did this).
  const edgeZWrapCacheRef = useRef<
    Map<(typeof edges)[number], (typeof edges)[number]>
  >(new Map());

  const displayEdges = useMemo(() => {
    // Cached module-level read — see `getInfoColor` above.
    const infoColor = getInfoColor();
    const prevCache = edgeZWrapCacheRef.current;
    const nextCache = new Map<(typeof edges)[number], (typeof edges)[number]>();

    const styleEdge = (e: (typeof edges)[number]): (typeof edges)[number] => {
      if (!infoColor) return e;
      const isNodeSelectionSelected = selectedEdgeIdSet.has(e.id);
      const shouldStaySelected =
        (!isBoxSelecting && !isLassoActive) ||
        (selectedNodeIds.has(e.source) && selectedNodeIds.has(e.target));
      const isVisuallySelected =
        isNodeSelectionSelected || (e.selected && shouldStaySelected);

      if (!isVisuallySelected) {
        if (!e.selected) return e;
        return { ...e, selected: false };
      }

      // Only allocate a new marker object when its color actually needs
      // to change; otherwise reuse the existing reference so the parent
      // edge can also be reused below.
      const recolor = (m: typeof e.markerEnd) => {
        if (!m || typeof m === 'string') return m;
        if (m.color === infoColor) return m;
        return { ...m, color: infoColor };
      };

      const nextMarkerEnd = recolor(e.markerEnd);
      const nextMarkerStart = recolor(e.markerStart);
      // Edge is already in the desired visual state — reuse its ref so
      // downstream consumers (xyflow's edge memo, selection toolbars)
      // skip rework.
      if (
        e.selected &&
        nextMarkerEnd === e.markerEnd &&
        nextMarkerStart === e.markerStart
      ) {
        return e;
      }

      return {
        ...e,
        selected: true,
        markerEnd: nextMarkerEnd,
        markerStart: nextMarkerStart,
      };
    };

    const result = edges.map((e) => {
      const styled = styleEdge(e);
      const z = edgeZIndex(zByNode, nodesById, e.source, e.target);

      // Reuse the wrapped edge emitted last render when the
      // selection-styled ref and derived z are both unchanged, so
      // xyflow's edge memo survives selection toggles.
      const cached = prevCache.get(styled);
      if (cached && cached.zIndex === z) {
        nextCache.set(styled, cached);
        return cached;
      }

      const finalEdge = styled.zIndex === z ? styled : { ...styled, zIndex: z };
      nextCache.set(styled, finalEdge);
      return finalEdge;
    });

    edgeZWrapCacheRef.current = nextCache;
    return result;
  }, [
    edges,
    isBoxSelecting,
    isLassoActive,
    selectedEdgeIdSet,
    selectedNodeIds,
    zByNode,
    nodesById,
  ]);

  // Cancel any other pending node placement (note / text / question) with Escape.
  useEffect(() => {
    if (!pendingNodeType || pendingNodeType === 'frame') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isOutsideCanvasInteraction(e.target)) return;
      if (e.key === 'Escape') exitPendingNodeType();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingNodeType, exitPendingNodeType]);

  const placePendingNode = useCallback(
    (clientX: number, clientY: number) => {
      if (
        !pendingNodeType ||
        pendingNodeType === 'frame' ||
        pendingNodeType === 'sketch'
      ) {
        return false;
      }
      const instance = rfInstanceRef.current;
      if (!instance) return false;

      const position = instance.screenToFlowPosition({
        x: clientX,
        y: clientY,
      });

      if (pendingNodeType === 'question') {
        createQuestionNodeAndCompose({
          addNode,
          placementPoint: position,
          canvasId,
        });
      } else {
        addNode({
          nodeType: pendingNodeType,
          placementPoint: position,
          data: {
            content: '',
            origin: { type: 'user-created' },
          },
        });
      }
      setPendingNodeType(null);
      return true;
    },
    [addNode, canvasId, pendingNodeType, setPendingNodeType],
  );

  // Click-to-place pointer recognizer for the pointer router. Backed by
  // refs so the recognizer is created once and never loses its in-flight
  // tap state to a re-render.
  const placePendingNodeRef = useRef(placePendingNode);
  placePendingNodeRef.current = placePendingNode;
  const suppressNextPaneClick = useCallback(() => {
    suppressNextPaneClickRef.current = true;
    window.setTimeout(() => {
      suppressNextPaneClickRef.current = false;
    }, 0);
  }, []);
  // Frame and lasso keep their existing self-gating handlers; the router
  // forwards native pointer events to them (read via refs so the recognizer
  // stays stable while the memoized handlers change identity).
  const frameHandlersRef = useRef(framePointerHandlers);
  frameHandlersRef.current = framePointerHandlers;
  const lassoHandlersRef = useRef(lassoPointerHandlers);
  lassoHandlersRef.current = lassoPointerHandlers;
  // Stroke-move gesture (drag inside the retained lasso region). Claims a
  // pointerdown before the lasso when it lands inside the selection polygon.
  const strokeMoveHandlers = useSketchStrokeMove({ rfInstanceRef });
  const strokeMoveHandlersRef = useRef(strokeMoveHandlers);
  strokeMoveHandlersRef.current = strokeMoveHandlers;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const pointerRecognizers = useMemo<
    PointerRecognizer<PointerEvent, CanvasPointerRouterContext>[]
  >(() => {
    const toReact = (event: PointerEvent) =>
      event as unknown as React.PointerEvent<HTMLDivElement>;
    return [
      createPlacementRecognizer({
        placePendingNode: (x, y) => placePendingNodeRef.current(x, y),
        suppressNextPaneClick,
      }),
      createHandlerOwnerRecognizer(
        'frame-drag',
        () => ({
          onPointerDown: (e) =>
            frameHandlersRef.current.onPointerDown(toReact(e)),
          onPointerMove: (e) =>
            frameHandlersRef.current.onPointerMove(toReact(e)),
          onPointerUp: (e) => frameHandlersRef.current.onPointerUp(toReact(e)),
          onPointerCancel: (e) =>
            frameHandlersRef.current.onPointerCancel(toReact(e)),
        }),
        (event, ctx) =>
          useToolStore.getState().pendingNodeType === 'frame' &&
          event.button === 0 &&
          event.isPrimary &&
          !isPanelTarget(event.target as Element | null) &&
          canDirectlyManipulateWithPointer(event.pointerType, ctx.inputMode),
      ),
      createHandlerOwnerRecognizer(
        'sketch-stroke-move',
        () => ({
          onPointerDown: (e) => strokeMoveHandlersRef.current.onPointerDown(e),
          onPointerMove: (e) => strokeMoveHandlersRef.current.onPointerMove(e),
          onPointerUp: (e) => strokeMoveHandlersRef.current.onPointerUp(e),
          onPointerCancel: (e) =>
            strokeMoveHandlersRef.current.onPointerCancel(e),
        }),
        (event, ctx) => {
          if (useToolStore.getState().pendingNodeType !== null) return false;
          if (toolRef.current !== 'lasso') return false;
          if (event.button !== 0 || !event.isPrimary) return false;
          if (!canStartRetainedSelectionMove(event.target as Element | null))
            return false;
          if (
            !canDirectlyManipulateWithPointer(event.pointerType, ctx.inputMode)
          )
            return false;
          // Grabbing the retained region drags the whole selection — the
          // strokes plus any whole nodes the lasso also caught (they move
          // together, see useSketchStrokeMove).
          const poly = useGesturePreviewStore.getState().sketchSelectionPolygon;
          if (!poly || poly.length < 3) return false;
          const inst = rfInstanceRef.current;
          if (!inst) return false;
          const flow = inst.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          });
          return isPointInFlowPolygon(flow.x, flow.y, poly);
        },
      ),
      createHandlerOwnerRecognizer(
        'lasso',
        () => ({
          onPointerDown: (e) =>
            lassoHandlersRef.current.onPointerDown(toReact(e)),
          onPointerMove: (e) =>
            lassoHandlersRef.current.onPointerMove(toReact(e)),
          onPointerUp: (e) => lassoHandlersRef.current.onPointerUp(toReact(e)),
          onPointerCancel: (e) =>
            lassoHandlersRef.current.onPointerCancel(toReact(e)),
        }),
        (event, ctx) =>
          useToolStore.getState().pendingNodeType === null &&
          toolRef.current === 'lasso' &&
          event.button === 0 &&
          event.isPrimary &&
          isLassoStartTarget(event.target as Element | null) &&
          canDirectlyManipulateWithPointer(event.pointerType, ctx.inputMode),
      ),
    ];
  }, [suppressNextPaneClick]);

  // Handle click-to-place for note, text, and question.
  const handlePaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (suppressNextPaneClickRef.current) {
        suppressNextPaneClickRef.current = false;
        return;
      }
      const preview = useGesturePreviewStore.getState();
      preview.clearSketchStrokeHighlight();
      // 1. Click-to-place for pending node creation tools.
      if (placePendingNode(event.clientX, event.clientY)) return;

      // 2. With a different creation tool still active (frame / sketch), the
      //    background click belongs to that tool — leave the expanded view
      //    alone so the user doesn't lose their context mid-gesture.
      if (pendingNodeType) return;

      if (preview.inkSubmissionPreparing) return;

      preview.clearSketchStrokeSelection();
      selectNodes([]);
    },
    [pendingNodeType, placePendingNode, selectNodes],
  );

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof ResizeObserver === 'undefined') return;

    let previousSize = {
      width: wrapper.clientWidth,
      height: wrapper.clientHeight,
    };
    const observer = new ResizeObserver(([entry]) => {
      const nextSize = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      if (nextSize.width <= 0 || nextSize.height <= 0) return;

      const instance = rfInstanceRef.current;
      if (!instance) {
        previousSize = nextSize;
        return;
      }

      const currentViewport = instance.getViewport();
      const nextViewport = anchorViewportCentre(
        currentViewport,
        previousSize,
        nextSize,
      );
      previousSize = nextSize;

      if (
        Math.abs(nextViewport.x - currentViewport.x) <
          VIEWPORT_CORRECTION_EPSILON_PX &&
        Math.abs(nextViewport.y - currentViewport.y) <
          VIEWPORT_CORRECTION_EPSILON_PX
      ) {
        return;
      }
      void instance.setViewport(nextViewport, { duration: 0 });
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const cancelHeightCommits = () => cancelHeightCommitSuspensions();
    const cancelWhenHidden = () => {
      if (document.visibilityState === 'hidden') cancelHeightCommits();
    };
    window.addEventListener('blur', cancelHeightCommits);
    window.addEventListener('pointercancel', cancelHeightCommits, true);
    document.addEventListener('visibilitychange', cancelWhenHidden);
    return () => {
      window.removeEventListener('blur', cancelHeightCommits);
      window.removeEventListener('pointercancel', cancelHeightCommits, true);
      document.removeEventListener('visibilitychange', cancelWhenHidden);
      cancelHeightCommits();
      rfInstanceRef.current = null;
      setRfInstance(null);
      // If the canvas is torn down mid-drag (route change, canvas
      // swap, expanded-view toggle) React Flow never fires
      // `onNodeDragStop`, so the snap state and its window-level Alt
      // listeners would leak. Aborting here detaches them in one
      // shot. No-op when no drag is active.
      endActiveDragSession();
    };
  }, [setRfInstance, endActiveDragSession]);

  // Mirror the wrapper element into the store so non-component code
  // paths (e.g. `dispatchUiIntent`'s viewport-centre computation) can
  // read its bounding rect without prop-drilling the ref.
  useEffect(() => {
    setCanvasWrapper(wrapperRef.current);
    return () => setCanvasWrapper(null);
  }, [setCanvasWrapper]);

  return (
    <div
      ref={wrapperRef}
      data-canvas-root=""
      tabIndex={-1}
      data-search-scope="canvas"
      aria-busy={isInitialViewportPending}
      data-not-mouse={isNotMouse ? '' : undefined}
      data-mouse-marquee={mouseMarqueeEnabled && !isNotMouse ? '' : undefined}
      className={clsx(
        'bg-bg-default relative flex h-full w-full flex-col',
        pendingNodeType === 'note' && 'canvas-pending-note',
        pendingNodeType === 'text' && 'canvas-pending-text',
        pendingNodeType === 'frame' && 'canvas-pending-frame',
        pendingNodeType === 'sketch' && 'cursor-crosshair',
        pendingNodeType === 'audio' && 'canvas-pending-audio',
        pendingNodeType === 'question' && 'canvas-pending-question',
        tool === 'lasso' && !isStrokeMoving && 'canvas-lasso cursor-crosshair',
        isStrokeMoving && 'cursor-grabbing',
      )}
      onContextMenu={(event) => {
        const target = event.target as Element;
        if (
          target.closest(
            'input, textarea, select, [contenteditable="true"], a[href]',
          )
        ) {
          return;
        }
        event.preventDefault();
      }}
      onDragOver={(e) => {
        // Accept both internal Huabu payloads and native file/URL drops
        const isHuabu = canReadHuabuPayload(e.dataTransfer);
        const hasFiles = e.dataTransfer.types.includes('Files');
        const hasUri = e.dataTransfer.types.includes('text/uri-list');
        const hasText = e.dataTransfer.types.includes('text/plain');
        if (!isHuabu && !hasFiles && !hasUri && !hasText) return;
        e.preventDefault();
        e.stopPropagation();
        // Default drag of an internal note that knows how to MOVE
        // its source range is treated as MOVE (matches Windows /
        // macOS file-manager conventions). Holding Option (macOS) or
        // Ctrl (Windows / Linux) downgrades it to a COPY. Everything
        // else — chat excerpts, web/image cards, external file drops
        // — stays a COPY because no source mutation is possible.
        // Cmd is deliberately NOT honored on macOS: the OS reserves
        // it for system-level NSDragOperation negotiation, so reading
        // it here would conflict with the OS-supplied operation and
        // cause `drop` to never fire.
        const isCopyModifier = isMac ? e.altKey : e.ctrlKey;
        const canMove = isHuabu && canMoveHuabuPayload(e.dataTransfer);
        e.dataTransfer.dropEffect =
          canMove && !isCopyModifier ? 'move' : 'copy';
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();

        const instance = rfInstanceRef.current;
        if (!instance) return;

        const dropPos = instance.screenToFlowPosition({
          x: e.clientX,
          y: e.clientY,
        });

        // ============ 1. Internal Huabu drag payloads ============
        if (canReadHuabuPayload(e.dataTransfer)) {
          const payload = getHuabuPayload(e.dataTransfer);
          if (!payload) return;

          // Deduplicate repeated drop events
          const dedupeKey = `drag:${payload.dragId}`;
          const now =
            typeof e.timeStamp === 'number' && e.timeStamp > 0
              ? e.timeStamp
              : Date.now();
          const lastDrop = lastDropRef.current;
          if (
            lastDrop &&
            lastDrop.key === dedupeKey &&
            now - lastDrop.at < 4000
          )
            return;
          lastDropRef.current = { key: dedupeKey, at: now };

          let newNodeInput: AddNodeInput | null = null;

          if (payload.kind === 'web') {
            newNodeInput = {
              nodeType: 'web',
              placementPoint: dropPos,
              data: { src: payload.data.src, origin: payload.origin },
            };
          }

          if (payload.kind === 'note') {
            const newNoteInput: AddNodeInput = {
              nodeType: 'note',
              placementPoint: dropPos,
              data: {
                content: payload.data.content,
                origin: payload.origin,
              },
            };

            // Default = MOVE (source loses the dragged range);
            // Option (macOS) / Ctrl (others) downgrades to COPY.
            // MOVE additionally requires a source node id and a
            // pre-computed post-MOVE snapshot, both absent when
            // dragging from non-editable surfaces (AI chat cards) —
            // those always fall back to COPY regardless of modifier
            // state.
            const { sourceNodeId, sourceContentAfterMove } = payload.data;
            const canMove =
              sourceNodeId !== undefined &&
              sourceContentAfterMove !== undefined;
            const isCopyModifier = isMac ? e.altKey : e.ctrlKey;
            const isMove = canMove && !isCopyModifier;

            if (isMove) {
              moveNoteExcerpt({
                sourceNodeId,
                sourceContentAfterMove,
                newNote: newNoteInput,
              });
            } else {
              addNode(newNoteInput);
            }
            return;
          }

          if (payload.kind === 'image') {
            const { src, label } = payload.data;

            const doAdd = (natW: number, natH: number) => {
              addNode({
                nodeType: 'image',
                placementPoint: dropPos,
                data: { src, label, origin: payload.origin },
                naturalDimensions: { width: natW, height: natH },
              });
            };

            const img = new Image();
            img.onload = () => doAdd(img.naturalWidth, img.naturalHeight);
            img.onerror = () => doAdd(0, 0);
            img.src = resolveArtifactUrl(src, canvasId ?? undefined);
            return;
          }

          if (newNodeInput) addNode(newNodeInput);
          return;
        }

        // ============ 2. Native file drops (from desktop / Finder) ============
        const nativeFiles = Array.from(e.dataTransfer.files);
        if (nativeFiles.length > 0) {
          if (!canvasId) return;
          void (async () => {
            const inputs = (
              await Promise.all(
                nativeFiles.map(async (file, i) => {
                  const offset = i * 30;
                  const pos = {
                    x: dropPos.x + offset,
                    y: dropPos.y + offset,
                  };
                  return uploadFileToNodeInput(
                    file,
                    pos,
                    { type: 'user-uploaded' },
                    canvasId,
                  );
                }),
              )
            ).filter((input): input is AddNodeInput => input !== null);
            if (inputs.length > 0) addNodes(inputs);
          })();
          return;
        }

        // ============ 3. URL drop (browser address bar, link drag) ============
        const uriList = e.dataTransfer.getData('text/uri-list');
        const plainText = e.dataTransfer.getData('text/plain');
        const droppedUrl = (uriList || plainText || '').trim();

        if (droppedUrl && looksLikeUrl(droppedUrl)) {
          addNode(
            urlToNodeInput(droppedUrl, dropPos, { type: 'user-uploaded' }),
          );
          return;
        }

        // ============ 4. Plain text drop ============
        if (plainText) {
          addNode(
            textToNoteNodeInput(plainText, dropPos, {
              type: 'user-uploaded',
            }),
          );
        }
      }}
    >
      <FrameZoomProvider>
        <ReactFlow
          className={cn(
            isInitialViewportPending && 'invisible',
            isStructuredReflowing && 'structured-reflow',
          )}
          defaultViewport={defaultViewport}
          deleteKeyCode={null}
          nodes={displayNodes}
          edges={displayEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          // A port is also the "create a connected node" button, so a plain
          // click on one has to reach `onConnectEnd`. React Flow only starts
          // (and therefore only ends) a connection once the pointer has moved
          // past `connectionDragThreshold`, which defaults to 1px — a click
          // that never moves would be dropped silently. Starting at 0px makes
          // press-and-release a first-class connect gesture.
          connectionDragThreshold={0}
          // React Flow's own click-to-connect would fight ours: it treats the
          // first port click as "arm a connection" and the next port click as
          // "complete it", silently drawing an edge between two ports the user
          // only meant to press the `+` on. Ports are our control now, so this
          // second, invisible click protocol has to be off.
          connectOnClick={false}
          isValidConnection={isValidConnection}
          connectionMode={ConnectionMode.Loose}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={(instance) => {
            rfInstanceRef.current = instance;
            setRfInstance(instance);
            fitInitialViewport(instance);
          }}
          onMoveStart={() => {
            // Pan and zoom both arrive here. A height correction committed
            // mid-gesture would resize a node the user is moving past, so
            // corrections queue up and land once the viewport settles.
            suspendHeightCommits('viewport');
          }}
          onMoveEnd={(_event, viewport) => {
            resumeHeightCommits('viewport');
            // Mirror pan/zoom into localStorage (per canvas) so browser and
            // desktop restarts restore the same view. Does NOT participate in
            // the structure autosave.
            setViewport(viewport);
          }}
          onPaneClick={handlePaneClick}
          onNodeDoubleClick={(e, node) => {
            e.stopPropagation();
            // Expand any expandable node type on double-click.
            if (EXPANDABLE_TYPES.has(node.type ?? '')) {
              openPreviewNode(node.id, { transient: true });
            }
          }}
          onEdgeDoubleClick={(e, edge) => {
            // Jump straight into the label editor — saves the user the
            // single-click-then-click-pill dance. `LabelledEdge` listens
            // for this event by id; see `EDIT_EDGE_LABEL_EVENT`.
            e.stopPropagation();
            const detail: EditEdgeLabelDetail = { edgeId: edge.id };
            window.dispatchEvent(
              new CustomEvent<EditEdgeLabelDetail>(EDIT_EDGE_LABEL_EVENT, {
                detail,
              }),
            );
          }}
          panOnDrag={
            isNotMouse
              ? false /* touch/pen → custom pointer router is the sole pan driver;
                       React Flow's d3-zoom touch pan (a separate Touch Events
                       stream) would otherwise still fire under a truthy
                       `[1]` and pan the canvas mid-frame/lasso/placement */
              : pendingNodeType
                ? [
                    1,
                  ] /* mouse + creation tool → middle mouse button still pans */
                : tool === 'pan'
                  ? true
                  : [
                      1,
                    ] /* mouse + selection tools → middle mouse button pans; drag box-selects */
          }
          // useCanvasShortcuts owns temporary Space-pan and the tool state
          // consumed by the pointer router; avoid a second keyboard owner.
          panActivationKeyCode={null}
          selectionOnDrag={false}
          // Mouse Select has one app-owned rectangle path, including Shift.
          // Other tools and non-mouse routing retain their native key policy.
          selectionKeyCode={
            !isNotMouse && tool === 'select' && !pendingNodeType
              ? null
              : 'Shift'
          }
          selectionMode={SelectionMode.Partial}
          onSelectionEnd={handleSelectionEnd}
          nodesDraggable={!pendingNodeType && tool !== 'lasso'}
          nodeDragThreshold={dragActivationDistance}
          nodeClickDistance={dragActivationDistance}
          elementsSelectable={!pendingNodeType}
          panOnScroll={!isNotMouse}
          zoomOnScroll={true}
          // Touch/pen pinch is driven by the custom pointer router (via
          // Pointer Events). React Flow's built-in pinch uses d3-zoom on a
          // *separate* Touch Events stream that our capture-phase pointer
          // suppression can't stop, so leaving it on lets both fight over
          // `setViewport` and the gesture stalls. Mirror `panOnDrag` above:
          // hand pan AND zoom to the router whenever a finger/pen is active,
          // keeping React Flow's pinch only for the mouse (trackpad) case.
          zoomOnPinch={!isNotMouse}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          onlyRenderVisibleElements
          // Huabu owns both forest order and transient sole-selection elevation.
          // Keep xyflow's automatic selection/parent bumps disabled: they do not
          // preserve our subtree order or the unchanged multi-selection policy.
          zIndexMode="manual"
          elevateNodesOnSelect={false}
        >
          <FrameZoomController scopeKey={canvasId} />
          <CanvasGestures
            wrapperRef={wrapperRef}
            rfInstanceRef={rfInstanceRef}
            inputMode={inputMode}
            explicitToolActive={tool === 'lasso' || Boolean(pendingNodeType)}
            mouseMarqueeEnabled={mouseMarqueeEnabled}
            canvasId={canvasId}
            onMarqueeActiveChange={setIsMouseMarqueeSelecting}
            onTouchTakeover={handleTouchTakeover}
            onEmptyCanvasTap={() => {
              const preview = useGesturePreviewStore.getState();
              preview.clearSketchStrokeHighlight();
              if (preview.inkSubmissionPreparing) return;
              preview.clearSketchStrokeSelection();
              selectNodes([]);
            }}
            onNodeTap={(nodeId) => {
              useGesturePreviewStore.getState().clearSketchStrokeHighlight();
              selectNodes([nodeId]);
            }}
            extraRecognizers={pointerRecognizers}
          />
          <SelectionAutoPan
            active={
              (isBoxSelecting && !isMouseMarqueeSelecting) || isLassoActive
            }
            wrapperRef={wrapperRef}
            onPan={shiftLassoScreenPoints}
          />
          {toolbarHost ? (
            createPortal(
              <div
                data-canvas-main-toolbar
                className="react-flow__panel nodrag nopan pointer-events-auto absolute !bottom-6 !left-1/2 !m-0 max-w-[calc(100%-24px)] -translate-x-1/2"
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
                onDragOver={(event) => event.stopPropagation()}
                onDrop={(event) => event.stopPropagation()}
              >
                <NodeToolbar activeTool={tool} onToolChange={setTool} />
              </div>,
              toolbarHost,
            )
          ) : (
            <Panel position="bottom-center" className="mb-6">
              <NodeToolbar activeTool={tool} onToolChange={setTool} />
            </Panel>
          )}
          <MultiSelectResizer />
          <SelectionOutlines />
          {!isBoxSelecting && !hasStrokeSelection && <MultiSelectToolbar />}
          {!isBoxSelecting && <StrokeSelectionRegion />}
          {!isBoxSelecting && <StrokeSelectionToolbar />}
          {!isBoxSelecting && <EdgeStyleToolbar />}
          <MoveSelectionModal />
          <ConnectedNodePicker
            anchor={connectPicker?.anchor ?? null}
            tether={
              connectPicker?.kind === 'point'
                ? {
                    nodeId: connectPicker.sourceId,
                    side: connectPicker.side,
                    to: connectPicker.anchor,
                  }
                : null
            }
            onSelect={handleConnectedKindPick}
            onDismiss={dismissConnectPicker}
          />
          <CanvasGrid />

          <CanvasZoomMenu />
          {minimapEnabled && (
            <MiniMap
              pannable
              zoomable
              ariaLabel="Minimap"
              className="border-edge-default rounded-md border shadow-sm"
            />
          )}

          {/* Sketch overlay inside ReactFlow so it shares stacking context with Panel */}
          {pendingNodeType === 'sketch' && (
            <SketchOverlay rfInstance={rfInstanceRef.current} />
          )}
        </ReactFlow>
      </FrameZoomProvider>

      {isInitialViewportPending && (
        <Loading
          variant="brand"
          layout="overlay"
          size="md"
          className="bg-bg-default z-100"
        />
      )}

      {lassoPreviewPath && (
        <svg
          className="pointer-events-none absolute inset-0 z-50 h-full w-full"
          aria-hidden="true"
        >
          <path
            d={lassoPreviewPath}
            fill="color-mix(in srgb, var(--color-info) 14%, transparent)"
            stroke="var(--color-info)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}

      {/* Frame drag preview overlay */}
      {frameDragRect && frameDragRect.width > 2 && (
        <div
          className="border-info bg-info-bg/40 pointer-events-none absolute z-50 rounded border border-dashed"
          style={{
            left: frameDragRect.left,
            top: frameDragRect.top,
            width: frameDragRect.width,
            height: frameDragRect.height,
          }}
        />
      )}

      {/* Frame auto-fit preview overlays — shown while dragging nodes near frames */}
      {frameFitPreviews.map((preview) => (
        <FrameFitPreviewOverlay
          key={preview.frameId}
          preview={preview}
          rfInstance={rfInstanceRef.current}
          wrapperRef={wrapperRef}
        />
      ))}

      {/* Structured-frame drop indicator — column/row track highlight or insert bar */}
      <StructuredDropOverlay
        rfInstance={rfInstanceRef.current}
        wrapperRef={wrapperRef}
      />

      {/* Smart-snap alignment guides — shown while dragging nodes */}
      <SnapGuidesOverlay
        rfInstance={rfInstanceRef.current}
        wrapperRef={wrapperRef}
      />
    </div>
  );
};
