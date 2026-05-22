import {
  ReactFlow,
  Background,
  Controls,
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

import { ImageNode } from '@/components/Nodes/image/ImageNode';
import { NoteNode } from '@/components/Nodes/note/NoteNode';
import { PDFNode } from '@/components/Nodes/pdf/PDFNode';
import { TextNode } from '@/components/Nodes/text/TextNode';
import {
  uploadFileToNodeInput,
  urlToNodeInput,
  textToNoteNodeInput,
} from '@/handler/canvasCommand/nodeInputBuilders';
import { useAutoPanDuringSelection } from '@/hooks/useAutoPanDuringSelection';
import { useCanvasGestures } from '@/hooks/useCanvasGestures';
import { useCanvasLasso } from '@/hooks/useCanvasLasso';
import { useCanvasShortcuts } from '@/hooks/useCanvasShortcuts';
import { useFrameDragToCreate } from '@/hooks/useFrameDragToCreate';
import { useIsNotMouse } from '@/hooks/useInputMode';
import { useQuestionRunner } from '@/hooks/useQuestionRunner';
import { useSketchHoverRouting } from '@/hooks/useSketchHoverRouting';
import { getEdgeIdsBetweenSelectedNodes } from '@/utils/selection';

import { NodeToolbar } from './CanvasToolbar.tsx';
import { EdgeStyleToolbar } from './FloatingToolbars/EdgeStyleToolbar.tsx';
import { MultiSelectToolbar } from './FloatingToolbars/MultiSelectToolbar.tsx';
import { IntentPopover } from './IntentPopover.tsx';
import { MultiSelectResizer } from './MultiSelectResizer.tsx';
import { SnapGuidesOverlay } from './SnapGuidesOverlay.tsx';
import { GRID_SIZE, MAX_ZOOM, MIN_ZOOM } from '../../../config/canvas.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import { useGesturePreviewStore } from '../../../store/gesturePreviewStore.ts';
import { useToolStore } from '../../../store/toolStore.ts';
import {
  canReadSedimentPayload,
  getSedimentPayload,
} from '../../../utils/io/dragDrop.ts';
import { looksLikeUrl } from '../../../utils/io/media.ts';
import { FrameNode } from '../../Nodes/frame/FrameNode.tsx';
import { QuestionNode } from '../../Nodes/question/QuestionNode.tsx';
import { SketchNode } from '../../Nodes/sketch/SketchNode.tsx';
import { SketchOverlay } from '../../Nodes/sketch/SketchOverlay.tsx';
import { SketchProcessingOverlay } from '../../Nodes/sketch/SketchProcessingOverlay.tsx';
import { VideoNode } from '../../Nodes/video/VideoNode.tsx';
import { WebNode } from '../../Nodes/web/WebNode.tsx';

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';
import type { CanvasViewport } from '@sediment/shared';
import type { FrameFitResult } from '@sediment/shared/canvas-engine';

const nodeTypes = {
  image: ImageNode,
  text: TextNode,
  note: NoteNode,
  video: VideoNode,
  web: WebNode,
  pdf: PDFNode,
  frame: FrameNode,
  sketch: SketchNode,
  question: QuestionNode,
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
const EXPANDABLE_TYPES = new Set(['image', 'video', 'web', 'pdf', 'note']);

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
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
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
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const onConnect = useCanvasStore((state) => state.onConnect);
  const onNodeDragStart = useCanvasStore((state) => state.onNodeDragStart);
  const onNodeDrag = useCanvasStore((state) => state.onNodeDrag);
  const onNodeDragStop = useCanvasStore((state) => state.onNodeDragStop);
  const endActiveDragSession = useCanvasStore(
    (state) => state.endActiveDragSession,
  );
  const frameFitPreviews = useGesturePreviewStore(
    (state) => state.frameFitPreviews,
  );
  const addNode = useCanvasStore((state) => state.addNode);
  const addNodes = useCanvasStore((state) => state.addNodes);
  const setRfInstance = useCanvasStore((state) => state.setRfInstance);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const openExpanded = useCanvasStore((state) => state.openExpanded);
  const expandedNodeId = useCanvasStore((state) => state.expandedNodeId);
  const expandMode = useCanvasStore((state) => state.expandMode);
  const frameNodesInRect = useCanvasStore((state) => state.frameNodesInRect);
  const canvasId = useCanvasStore((state) => state.canvasId);
  const selectNodes = useCanvasStore((state) => state.selectNodes);
  const pendingNodeType = useToolStore((state) => state.pendingNodeType);
  const setPendingNodeType = useToolStore((state) => state.setPendingNodeType);

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

  // Run question nodes when their timers expire.
  useQuestionRunner();

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
  const displayNodes = useMemo<typeof nodes>(
    () =>
      nodes.map((node) => {
        const className = clsx(
          node.className,
          lassoPreviewNodeIdSet.has(node.id) && 'canvas-lasso-preview',
        );

        return className ? { ...node, className } : node;
      }),
    [lassoPreviewNodeIdSet, nodes],
  );

  // Override marker colors on selected edges so arrows match the selection
  // highlight color (--color-info). CSS cannot style SVG <marker> referenced
  // via url() from <defs>, so we swap the marker config in JS.
  const displayEdges = useMemo(() => {
    const infoColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-info')
      .trim();
    if (!infoColor) return edges;
    return edges.map((e) => {
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

        return {
          ...e,
          selected: false,
        };
      }

      const recolor = (m: typeof e.markerEnd) => {
        if (!m || typeof m === 'string') return m;
        return { ...m, color: infoColor };
      };

      return {
        ...e,
        selected: true,
        markerEnd: recolor(e.markerEnd),
        markerStart: recolor(e.markerStart),
      };
    });
  }, [
    edges,
    isBoxSelecting,
    lassoPreviewEdgeIdSet,
    selectedEdgeIdSet,
    selectedNodeIds,
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

  // Handle click-to-place for note, text, and question
  const handlePaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (
        !pendingNodeType ||
        pendingNodeType === 'frame' ||
        pendingNodeType === 'sketch'
      )
        return;
      const instance = rfInstanceRef.current;
      if (!instance) return;

      const position = instance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const data: Record<string, unknown> =
        pendingNodeType === 'question'
          ? {
              input: { kind: 'text', content: '' },
              status: 'idle',
              origin: { type: 'user-created' },
            }
          : {
              content: '',
              origin: { type: 'user-created' },
            };

      addNode({
        nodeType: pendingNodeType,
        placementPoint: position,
        data,
      });
      setPendingNodeType(null);
    },
    [pendingNodeType, addNode, setPendingNodeType],
  );

  // When a node is expanded in split mode, pan the canvas so the node stays visible.
  useEffect(() => {
    if (!expandedNodeId || expandMode !== 'split') return;
    // Wait for the canvas container to finish resizing before fitting.
    const timer = setTimeout(() => {
      rfInstanceRef.current?.fitView({
        nodes: [{ id: expandedNodeId }],
        duration: 300,
        maxZoom: rfInstanceRef.current.getZoom(),
        padding: 0.15,
      });
    }, 100);
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

  return (
    <div
      ref={wrapperRef}
      className={clsx(
        'bg-bg-default relative flex h-full w-full flex-col',
        pendingNodeType === 'note' && 'canvas-pending-note',
        pendingNodeType === 'text' && 'canvas-pending-text',
        pendingNodeType === 'frame' && 'canvas-pending-frame',
        pendingNodeType === 'sketch' && 'cursor-crosshair',
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
        e.dataTransfer.dropEffect = 'copy';
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
            newNodeInput = {
              nodeType: 'note',
              placementPoint: dropPos,
              data: {
                content: payload.data.content,
                origin: payload.origin,
              },
            };
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
            img.src = src;
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
        onInit={(instance) => {
          rfInstanceRef.current = instance;
          setRfInstance(instance);
        }}
        onMoveEnd={(_event, viewport) => {
          // Persist pan/zoom so reopening the canvas lands the user in
          // the same spot. Rides the standard 1s autosave debounce.
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
        attributionPosition="bottom-right"
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
        {!isBoxSelecting && <MultiSelectToolbar />}
        {!isBoxSelecting && <EdgeStyleToolbar />}
        <IntentPopover />
        <Background color="var(--canvas-grid)" gap={GRID_SIZE} />

        <Controls position="bottom-left" />

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

      {/* Smart-snap alignment guides — shown while dragging nodes */}
      <SnapGuidesOverlay
        rfInstance={rfInstanceRef.current}
        wrapperRef={wrapperRef}
      />
    </div>
  );
};
