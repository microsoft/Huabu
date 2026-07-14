import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  ConnectionMode,
  SelectionMode,
  type ReactFlowInstance,
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
import '@xyflow/react/dist/style.css';

import {
  assignNodeZIndices,
  edgeZIndex,
  indexById,
} from '@sediment/shared/canvas-engine';

import { resolveArtifactUrl } from '@/api/artifact';
import { AudioNode } from '@/components/Nodes/audio/AudioNode';
import { ImageNode } from '@/components/Nodes/image/ImageNode';
import { NoteNode } from '@/components/Nodes/note/NoteNode';
import { OfficeNode } from '@/components/Nodes/office/OfficeNode';
import { PDFNode } from '@/components/Nodes/pdf/PDFNode';
import { TextNode } from '@/components/Nodes/text/TextNode';
import {
  uploadFileToNodeInput,
  urlToNodeInput,
  textToNoteNodeInput,
} from '@/handler/canvasCommand/nodeInputBuilders';
import { useCanvasShortcuts } from '@/hooks/shortcuts';
import { useAutoPanDuringSelection } from '@/hooks/useAutoPanDuringSelection';
import { useCanvasGestures } from '@/hooks/useCanvasGestures';
import { useCanvasLasso } from '@/hooks/useCanvasLasso';
import { useFrameDragToCreate } from '@/hooks/useFrameDragToCreate';
import { useIsNotMouse } from '@/hooks/useInputMode';
import { useSketchHoverRouting } from '@/hooks/useSketchHoverRouting';
import { isMac } from '@/utils/platform';
import { getEdgeIdsBetweenSelectedNodes } from '@/utils/selection';

import { NodeToolbar } from './CanvasToolbar.tsx';
import {
  EDIT_EDGE_LABEL_EVENT,
  LabelledEdge,
  type EditEdgeLabelDetail,
} from './edges/LabelledEdge.tsx';
import { EdgeStyleToolbar } from './FloatingToolbars/EdgeStyleToolbar.tsx';
import { MultiSelectToolbar } from './FloatingToolbars/MultiSelectToolbar.tsx';
import { IntentPopover } from './IntentPopover.tsx';
import { MultiSelectResizer } from './MultiSelectResizer.tsx';
import { SelectionOutlines } from './SelectionOutlines.tsx';
import { SnapGuidesOverlay } from './SnapGuidesOverlay.tsx';
import { StructuredDropOverlay } from './StructuredDropOverlay.tsx';
import { GRID_SIZE, MAX_ZOOM, MIN_ZOOM } from '../../../config/canvas.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import { useGesturePreviewStore } from '../../../store/gesturePreviewStore.ts';
import { usePreviewStore } from '../../../store/previewStore.ts';
import { useToolStore } from '../../../store/toolStore.ts';
import {
  canMoveSedimentPayload,
  canReadSedimentPayload,
  getSedimentPayload,
} from '../../../utils/io/dragDrop.ts';
import { looksLikeUrl } from '../../../utils/io/media.ts';
import { FrameNode } from '../../Nodes/frame/FrameNode.tsx';
import { createQuestionNodeAndCompose } from '../../Nodes/question/questionCompose.ts';
import { QuestionNode } from '../../Nodes/question/QuestionNode.tsx';
import { SketchNode } from '../../Nodes/sketch/SketchNode.tsx';
import { SketchOverlay } from '../../Nodes/sketch/SketchOverlay.tsx';
import { SketchProcessingOverlay } from '../../Nodes/sketch/SketchProcessingOverlay.tsx';
import { VideoNode } from '../../Nodes/video/VideoNode.tsx';
import { WebNode } from '../../Nodes/web/WebNode.tsx';

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';
import type { CanvasViewport } from '@sediment/shared';
import type {
  FrameFitResult,
  NestableNode,
} from '@sediment/shared/canvas-engine';

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
}> = ({ wrapperRef, rfInstanceRef }) => {
  useCanvasGestures(wrapperRef, rfInstanceRef);
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

export const Canvas: React.FC<CanvasProps> = ({
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
  const expandedNodeId = useCanvasStore((state) => state.expandedNodeId);
  const expandMode = useCanvasStore((state) => state.expandMode);
  const canvasId = useCanvasStore((state) => state.canvasId);
  const minimapEnabled = useCanvasStore((state) => state.minimapEnabled);
  const pendingNodeType = useToolStore((state) => state.pendingNodeType);
  const frameFitPreviews = useGesturePreviewStore(
    (state) => state.frameFitPreviews,
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
    openExpanded,
    closeExpanded,
    frameNodesInRect,
    selectNodes,
  } = useCanvasStore.getState();
  const { setPendingNodeType } = useToolStore.getState();

  const [isBoxSelecting, setIsBoxSelecting] = useState(false);
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
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);
  const lastDropRef = useRef<{ key: string; at: number } | null>(null);
  const mousePositionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

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

  const isNotMouse = useIsNotMouse();

  const handleSelectionStart = useCallback(() => {
    if (tool !== 'select') return;
    setIsBoxSelecting(true);
  }, [tool]);

  // Sync the box-selected nodes back through the standard SELECT_NODES intent
  // so action history and event buffer stay in step with the visible selection.
  const handleSelectionEnd = useCallback(() => {
    setIsBoxSelecting(false);
    if (tool !== 'select') return;
    selectNodes(nodes.filter((n) => n.selected).map((n) => n.id));
  }, [nodes, selectNodes, tool]);

  // When a connection drag ends without landing on a handle, check if the
  // pointer is over a node element and create the connection anyway.
  // This makes connecting much easier on touch devices.
  const onConnectEnd = useCallback(
    (
      event: MouseEvent | TouchEvent,
      connectionState: {
        fromNode?: { id: string } | null;
        isValid: boolean | null;
      },
    ) => {
      // If React Flow already handled this as a valid connection, skip.
      if (connectionState.isValid) return;

      const sourceNodeId = connectionState.fromNode?.id;
      if (!sourceNodeId) return;

      // Determine the element under the pointer
      const target =
        event instanceof TouchEvent
          ? document.elementFromPoint(
              event.changedTouches[0].clientX,
              event.changedTouches[0].clientY,
            )
          : (event.target as Element);

      const nodeEl = target?.closest('.react-flow__node');
      if (!nodeEl) return;

      const targetNodeId = nodeEl.getAttribute('data-id');
      if (!targetNodeId || targetNodeId === sourceNodeId) return;

      onConnect({
        source: sourceNodeId,
        target: targetNodeId,
        sourceHandle: null,
        targetHandle: null,
      });
    },
    [onConnect],
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
    previewNodeIds,
    previewEdgeIds,
    isActive: isLassoActive,
    shiftScreenPoints: shiftLassoScreenPoints,
  } = useCanvasLasso({
    active: !pendingNodeType && tool === 'lasso',
    wrapperRef,
    rfInstanceRef,
    edges,
    onSelect: (nodeIds) => selectNodes(nodeIds),
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
  const lassoPreviewNodeIdSet = useMemo(
    () => new Set(previewNodeIds),
    [previewNodeIds],
  );
  const lassoPreviewEdgeIdSet = useMemo(
    () => new Set(previewEdgeIds),
    [previewEdgeIds],
  );
  // Manual z-order: array/forest order is the sole stacking authority
  // (see `assignNodeZIndices`). React Flow runs in `zIndexMode="manual"`
  // so these derived values are used verbatim; without this a framed
  // node always paints above unframed siblings regardless of order.
  const nodesById = useMemo(() => indexById(nodes as NestableNode[]), [nodes]);
  const zByNode = useMemo(
    () => assignNodeZIndices(nodes as NestableNode[]),
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

    const result = nodes.map((node) => {
      const z = zByNode.get(node.id) ?? 0;
      const wantsLassoClass = lassoPreviewNodeIdSet.has(node.id);
      const baseClassName = node.className;
      const nextClassName = wantsLassoClass
        ? clsx(baseClassName, 'canvas-lasso-preview')
        : baseClassName;

      const cached = prevCache.get(node);
      if (cached && cached.zIndex === z && cached.className === nextClassName) {
        nextCache.set(node, cached);
        return cached;
      }

      const needsWrap = nextClassName !== baseClassName || node.zIndex !== z;
      const wrapped = needsWrap
        ? { ...node, className: nextClassName, zIndex: z }
        : node;
      nextCache.set(node, wrapped);
      return wrapped;
    });

    zWrapCacheRef.current = nextCache;
    return result;
  }, [lassoPreviewNodeIdSet, nodes, zByNode]);

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
      const isLassoPreviewSelected = lassoPreviewEdgeIdSet.has(e.id);
      const isNodeSelectionSelected = selectedEdgeIdSet.has(e.id);
      const shouldStaySelected =
        !isBoxSelecting ||
        (selectedNodeIds.has(e.source) && selectedNodeIds.has(e.target));
      const isVisuallySelected =
        isLassoPreviewSelected ||
        isNodeSelectionSelected ||
        (e.selected && shouldStaySelected);

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
    lassoPreviewEdgeIdSet,
    selectedEdgeIdSet,
    selectedNodeIds,
    zByNode,
    nodesById,
  ]);

  // Cancel any other pending node placement (note / text / question) with Escape.
  useEffect(() => {
    if (!pendingNodeType || pendingNodeType === 'frame') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitPendingNodeType();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingNodeType, exitPendingNodeType]);

  // Handle click-to-place for note, text, and question; otherwise dismiss
  // any currently expanded view (preview or node) so clicking the canvas
  // background acts as a quick close gesture in split mode.
  const handlePaneClick = useCallback(
    (event: React.MouseEvent) => {
      // 1. Click-to-place for pending node creation tools.
      if (
        pendingNodeType &&
        pendingNodeType !== 'frame' &&
        pendingNodeType !== 'sketch'
      ) {
        const instance = rfInstanceRef.current;
        if (!instance) return;

        const position = instance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });

        // Question nodes are born bound to a chat thread: mint the node
        // id + thread id up front so we can drop the node AND jump
        // straight into compose (open the panel, focus the input, pick
        // the agent inline). Presetting `id` is supported by the
        // ADD_NODES resolver and already used by paste.
        if (pendingNodeType === 'question') {
          createQuestionNodeAndCompose({
            addNode,
            placementPoint: position,
            canvasId,
          });
          setPendingNodeType(null);
          return;
        }

        const data: Record<string, unknown> = {
          content: '',
          origin: { type: 'user-created' },
        };

        addNode({
          nodeType: pendingNodeType,
          placementPoint: position,
          data,
        });
        setPendingNodeType(null);
        return;
      }

      // 2. With a different creation tool still active (frame / sketch), the
      //    background click belongs to that tool — leave the expanded view
      //    alone so the user doesn't lose their context mid-gesture.
      if (pendingNodeType) return;

      // 3. No tool active → background click closes the expanded view.
      //    Priority preview > node mirrors ExpandedNodePanel's Escape handler.
      const { previewType, previewData, closePreview } =
        usePreviewStore.getState();
      if (previewType && previewData) {
        closePreview();
        return;
      }
      if (expandedNodeId) {
        closeExpanded();
      }
    },
    [
      pendingNodeType,
      addNode,
      setPendingNodeType,
      expandedNodeId,
      closeExpanded,
      canvasId,
    ],
  );

  // When a node is expanded in split mode, pan the canvas so the node stays visible.
  useEffect(() => {
    if (!expandedNodeId || expandMode !== 'split') return;
    // Wait for the canvas container's `data-animate-width` CSS transition
    // (220ms, see index.css) to fully settle before fitting — otherwise
    // React Flow still has the pre-transition (larger) container size and
    // the node ends up centered in the old viewport instead of the new one.
    const timer = setTimeout(() => {
      rfInstanceRef.current?.fitView({
        nodes: [{ id: expandedNodeId }],
        duration: 300,
        maxZoom: rfInstanceRef.current.getZoom(),
        padding: 0.15,
      });
    }, 260);
    return () => clearTimeout(timer);
  }, [expandedNodeId, expandMode]);

  // Snapshot the persisted viewport (or decide to fit) at the moment
  // this component mounts so React Flow's *first* render uses it
  // directly via the `defaultViewport` / `fitView` props. Eliminates
  // the visible jump from the default `(0, 0, 1)` viewport to the
  // restored value that happened when we used to call `setViewport`
  // after mount.
  //
  // `CanvasPage` only mounts `<Canvas>` once the URL canvas matches
  // the store and `isLoading` is `false`, so reading the store
  // imperatively here is always safe — the snapshot is taken exactly
  // once per canvas load and never invalidated by later pan/zoom or
  // node edits (`defaultViewport`/`fitView` only take effect on the
  // React Flow instance's first mount anyway).
  const initialViewportProps = useMemo<{
    defaultViewport?: CanvasViewport;
    fitView?: boolean;
    fitViewOptions?: { padding: number };
  }>(() => {
    const { viewport, nodes: snapshotNodes } = useCanvasStore.getState();
    if (viewport) return { defaultViewport: viewport };
    if (snapshotNodes.length > 0) {
      return { fitView: true, fitViewOptions: { padding: 0.15 } };
    }
    return {};
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot on mount only; `canvasId` is here purely to document intent.
  }, [canvasId]);

  useEffect(() => {
    return () => {
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
      data-search-scope="canvas"
      className={clsx(
        'bg-bg-default relative flex h-full w-full flex-col',
        pendingNodeType === 'note' && 'canvas-pending-note',
        pendingNodeType === 'text' && 'canvas-pending-text',
        pendingNodeType === 'frame' && 'canvas-pending-frame',
        pendingNodeType === 'sketch' && 'cursor-crosshair',
        pendingNodeType === 'audio' && 'canvas-pending-audio',
        pendingNodeType === 'question' && 'canvas-pending-question',
        tool === 'lasso' && 'cursor-crosshair',
      )}
      onPointerDown={(event) => {
        framePointerHandlers.onPointerDown(event);
        lassoPointerHandlers.onPointerDown(event);
      }}
      onPointerMove={(event) => {
        framePointerHandlers.onPointerMove(event);
        lassoPointerHandlers.onPointerMove(event);
      }}
      onPointerUp={(event) => {
        framePointerHandlers.onPointerUp(event);
        lassoPointerHandlers.onPointerUp(event);
      }}
      onPointerCancel={(event) => {
        framePointerHandlers.onPointerCancel(event);
        lassoPointerHandlers.onPointerCancel(event);
      }}
      onDragOver={(e) => {
        // Accept both internal Sediment payloads and native file/URL drops
        const isSediment = canReadSedimentPayload(e.dataTransfer);
        const hasFiles = e.dataTransfer.types.includes('Files');
        const hasUri = e.dataTransfer.types.includes('text/uri-list');
        const hasText = e.dataTransfer.types.includes('text/plain');
        if (!isSediment && !hasFiles && !hasUri && !hasText) return;
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
        const canMove = isSediment && canMoveSedimentPayload(e.dataTransfer);
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

        // ============ 1. Internal Sediment drag payloads ============
        if (canReadSedimentPayload(e.dataTransfer)) {
          const payload = getSedimentPayload(e.dataTransfer);
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
      <ReactFlow
        {...initialViewportProps}
        deleteKeyCode={null}
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        connectionMode={ConnectionMode.Loose}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(instance) => {
          rfInstanceRef.current = instance;
          setRfInstance(instance);
        }}
        onMoveEnd={(_event, viewport) => {
          // Mirror pan/zoom into sessionStorage (per tab, per canvas)
          // so a refresh restores the same view. Does NOT participate
          // in the structure autosave.
          setViewport(viewport);
        }}
        onPaneClick={handlePaneClick}
        onNodeDoubleClick={(e, node) => {
          e.stopPropagation();
          // Expand any expandable node type on double-click.
          if (EXPANDABLE_TYPES.has(node.type ?? '')) {
            openExpanded(node.id);
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
          pendingNodeType
            ? [1] /* creation tool active → middle mouse button still pans */
            : tool === 'pan'
              ? true
              : isNotMouse
                ? false /* non-mouse + select tool → drag creates selection rect */
                : [1] /* mouse + selection tools → middle mouse button pans */
        }
        selectionOnDrag={pendingNodeType ? false : tool === 'select'}
        selectionMode={SelectionMode.Partial}
        onSelectionStart={handleSelectionStart}
        onSelectionEnd={handleSelectionEnd}
        nodesDraggable={!pendingNodeType && tool !== 'lasso'}
        elementsSelectable={!pendingNodeType}
        panOnScroll={!isNotMouse}
        zoomOnScroll={true}
        zoomOnPinch={true}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        onlyRenderVisibleElements
        // Design-tool style: selecting a node MUST NOT alter its z-order. The
        // selection indicator (drawn by `<SelectionOutlines />` below)
        // lives on a separate overlay layer that is always on top, so we
        // do not need xyflow's `+1000` internal-z bump to make the ring
        // visible. Disabling this also stops a selected covered node
        // from popping above the node covering it, which previously felt
        // like the click silently reordered the layers.
        // Manual z-order: Sediment derives every node's `zIndex` from
        // forest order (`assignNodeZIndices`) so the Layers-panel / array
        // order is the SOLE stacking authority. `auto` would instead force
        // framed subtrees above unframed siblings and lift framed frames by
        // a fixed band, making a node unable to cover a frame by order.
        zIndexMode="manual"
        elevateNodesOnSelect={false}
      >
        <CanvasGestures wrapperRef={wrapperRef} rfInstanceRef={rfInstanceRef} />
        <SelectionAutoPan
          active={isBoxSelecting || isLassoActive}
          wrapperRef={wrapperRef}
          onPan={shiftLassoScreenPoints}
        />
        <Panel position="bottom-center" className="mb-6">
          <NodeToolbar activeTool={tool} onToolChange={setTool} />
        </Panel>
        {!isBoxSelecting && <MultiSelectResizer />}
        {!isBoxSelecting && <SelectionOutlines />}
        {!isBoxSelecting && <MultiSelectToolbar />}
        {!isBoxSelecting && <EdgeStyleToolbar />}
        <IntentPopover />
        <Background color="var(--canvas-grid)" gap={GRID_SIZE} />

        <Controls position="bottom-left" />
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

        {/* Sketch intent processing overlay — lives in flow space so it pans/zooms with the canvas */}
        <SketchProcessingOverlay />
      </ReactFlow>

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
