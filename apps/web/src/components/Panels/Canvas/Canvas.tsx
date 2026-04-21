import { createId } from '@sediment/shared';
import {
  ReactFlow,
  Background,
  Controls,
  ConnectionMode,
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
  textToNodeInput,
} from '@/handler/canvasCommand/nodeInputBuilders';
import { useCanvasShortcuts } from '@/hooks/useCanvasShortcuts';
import { useIsTouch } from '@/hooks/useInputMode';
import { usePromptRunner } from '@/hooks/usePromptRunner';

import { NodeToolbar } from './CanvasToolbar.tsx';
import { EdgeStyleToolbar } from './EdgeStyleToolbar.tsx';
import { IntentPopover } from './IntentPopover.tsx';
import { MultiSelectToolbar } from './MultiSelectToolbar.tsx';
import { getSource } from '../../../api/knowledge.ts';
import { GRID_SIZE } from '../../../config/canvas.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import {
  canReadSedimentPayload,
  getSedimentPayload,
} from '../../../utils/io/dragDrop.ts';
import { looksLikeUrl } from '../../../utils/io/media.ts';
import { FrameNode } from '../../Nodes/frame/FrameNode.tsx';
import { PromptNode } from '../../Nodes/prompt/PromptNode.tsx';
import { VideoNode } from '../../Nodes/video/VideoNode.tsx';
import { WebNode } from '../../Nodes/web/WebNode.tsx';

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';
import type { FrameFitResult } from '@/handler/canvasCommand/utils/frame';

const nodeTypes = {
  image: ImageNode,
  text: TextNode,
  note: NoteNode,
  video: VideoNode,
  web: WebNode,
  pdf: PDFNode,
  frame: FrameNode,
  prompt: PromptNode,
} as const;

const VALID_NODE_TYPES = Object.keys(nodeTypes);

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

type CanvasProps = {
  shortcutsDisabled?: boolean;
};

export const Canvas: React.FC<CanvasProps> = ({
  shortcutsDisabled = false,
}) => {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);

  // Override marker colors on selected edges so arrows match the selection
  // highlight color (--color-info). CSS cannot style SVG <marker> referenced
  // via url() from <defs>, so we swap the marker config in JS.
  const displayEdges = useMemo(() => {
    const infoColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-info')
      .trim();
    if (!infoColor) return edges;
    return edges.map((e) => {
      if (!e.selected) return e;
      const recolor = (m: typeof e.markerEnd) => {
        if (!m || typeof m === 'string') return m;
        return { ...m, color: infoColor };
      };
      return {
        ...e,
        markerEnd: recolor(e.markerEnd),
        markerStart: recolor(e.markerStart),
      };
    });
  }, [edges]);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const onConnect = useCanvasStore((state) => state.onConnect);
  const onNodeDragStart = useCanvasStore((state) => state.onNodeDragStart);
  const onNodeDrag = useCanvasStore((state) => state.onNodeDrag);
  const onNodeDragStop = useCanvasStore((state) => state.onNodeDragStop);
  const frameFitPreviews = useCanvasStore((state) => state.frameFitPreviews);
  const addNode = useCanvasStore((state) => state.addNode);
  const addNodes = useCanvasStore((state) => state.addNodes);
  const patchNodeSilent = useCanvasStore((state) => state.patchNodeSilent);
  const setRfInstance = useCanvasStore((state) => state.setRfInstance);
  const openExpanded = useCanvasStore((state) => state.openExpanded);
  const expandedNodeId = useCanvasStore((state) => state.expandedNodeId);
  const expandMode = useCanvasStore((state) => state.expandMode);
  const frameNodesInRect = useCanvasStore((state) => state.frameNodesInRect);
  const pendingNodeType = useCanvasStore((state) => state.pendingNodeType);
  const setPendingNodeType = useCanvasStore(
    (state) => state.setPendingNodeType,
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

  const isTouch = useIsTouch();

  // Run prompt nodes when their timers expire.
  usePromptRunner();

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

  // --- Frame drag-to-create state ---
  const [frameDragStart, setFrameDragStart] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [frameDragEnd, setFrameDragEnd] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const isDraggingFrame = frameDragStart !== null;

  const resetFrameDrag = useCallback(() => {
    setFrameDragStart(null);
    setFrameDragEnd(null);
    setPendingNodeType(null);
  }, [setPendingNodeType]);

  // Cancel pending node placement with Escape key
  useEffect(() => {
    if (!pendingNodeType) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        resetFrameDrag();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingNodeType, resetFrameDrag]);

  // Handle click-to-place for note, text, and prompt
  const handlePaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (!pendingNodeType || pendingNodeType === 'frame') return;
      const instance = rfInstanceRef.current;
      if (!instance) return;

      const position = instance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const data: Record<string, unknown> =
        pendingNodeType === 'prompt'
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
        skipAutoLayout: true,
      });
      setPendingNodeType(null);
    },
    [pendingNodeType, addNode, setPendingNodeType],
  );

  // --- Frame drag-to-create handlers ---
  const handleFrameMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (pendingNodeType !== 'frame') return;
      // Only left button
      if (e.button !== 0) return;
      // Ignore clicks on toolbar / modals
      const target = e.target as HTMLElement;
      if (target.closest('.react-flow__panel')) return;

      e.preventDefault();
      e.stopPropagation();
      setFrameDragStart({ x: e.clientX, y: e.clientY });
      setFrameDragEnd({ x: e.clientX, y: e.clientY });
    },
    [pendingNodeType],
  );

  const handleFrameMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDraggingFrame) return;
      setFrameDragEnd({ x: e.clientX, y: e.clientY });
    },
    [isDraggingFrame],
  );

  const handleFrameMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (!isDraggingFrame || !frameDragStart || !frameDragEnd) return;

      const instance = rfInstanceRef.current;
      if (!instance) {
        resetFrameDrag();
        return;
      }

      const startFlow = instance.screenToFlowPosition({
        x: frameDragStart.x,
        y: frameDragStart.y,
      });
      const endFlow = instance.screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      const x = Math.min(startFlow.x, endFlow.x);
      const y = Math.min(startFlow.y, endFlow.y);
      const w = Math.abs(endFlow.x - startFlow.x);
      const h = Math.abs(endFlow.y - startFlow.y);

      // Minimum size threshold (in screen px) to avoid accidental tiny frames
      const MIN_SIZE = 20;
      if (w >= MIN_SIZE && h >= MIN_SIZE) {
        frameNodesInRect({ x, y, width: w, height: h });
      }

      resetFrameDrag();
    },
    [
      isDraggingFrame,
      frameDragStart,
      frameDragEnd,
      frameNodesInRect,
      resetFrameDrag,
    ],
  );

  // Compute the preview rectangle in screen-space
  const frameDragRect = (() => {
    if (!frameDragStart || !frameDragEnd) return null;
    const wrapperBounds = wrapperRef.current?.getBoundingClientRect();
    if (!wrapperBounds) return null;
    const x1 = frameDragStart.x - wrapperBounds.left;
    const y1 = frameDragStart.y - wrapperBounds.top;
    const x2 = frameDragEnd.x - wrapperBounds.left;
    const y2 = frameDragEnd.y - wrapperBounds.top;
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  })();

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

  // Boost trackpad pinch-to-zoom sensitivity.
  // Windows touchpads emit ctrlKey+wheel events with very small deltaY values,
  // resulting in sluggish, non-continuous zoom under d3-zoom's default
  // sensitivity (0.002). We intercept these events in the capture phase
  // (before d3-zoom sees them), apply a higher multiplier, and zoom towards
  // the cursor position for a natural feel.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      // Only handle pinch-to-zoom (ctrlKey + wheel)
      if (!e.ctrlKey) return;

      const instance = rfInstanceRef.current;
      if (!instance) return;

      // 10× the default d3-zoom wheel sensitivity
      const SENSITIVITY = 0.02;
      const { x, y, zoom } = instance.getViewport();
      const factor = Math.pow(2, -e.deltaY * SENSITIVITY);
      const newZoom = Math.max(0.1, Math.min(5, zoom * factor));

      if (newZoom === zoom) return;

      e.preventDefault();
      e.stopPropagation();

      // Zoom towards the cursor position
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const flowX = (cx - x) / zoom;
      const flowY = (cy - y) / zoom;

      instance.setViewport(
        {
          x: cx - flowX * newZoom,
          y: cy - flowY * newZoom,
          zoom: newZoom,
        },
        { duration: 0 },
      );
    };

    el.addEventListener('wheel', handleWheel, {
      capture: true,
      passive: false,
    });
    return () =>
      el.removeEventListener('wheel', handleWheel, { capture: true });
  }, []);

  useEffect(() => {
    return () => {
      rfInstanceRef.current = null;
      setRfInstance(null);
    };
  }, [setRfInstance]);

  return (
    <div
      ref={wrapperRef}
      className={clsx(
        'bg-bg-default relative flex h-full w-full flex-col',
        pendingNodeType === 'note' && 'canvas-pending-note',
        pendingNodeType === 'text' && 'canvas-pending-text',
        pendingNodeType === 'frame' && 'canvas-pending-frame',
        pendingNodeType === 'prompt' && 'canvas-pending-prompt',
      )}
      onMouseDown={handleFrameMouseDown}
      onMouseMove={handleFrameMouseMove}
      onMouseUp={handleFrameMouseUp}
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
                ...(payload.data.contentJson
                  ? { contentJson: payload.data.contentJson }
                  : {}),
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

          if (payload.kind === 'source') {
            const { type, sourceId, label, ...rest } = payload.data;

            let nodeType = 'text';
            if (typeof type === 'string' && VALID_NODE_TYPES.includes(type)) {
              nodeType = type;
            }

            // For note/text sources, async-load content
            if ((nodeType === 'note' || nodeType === 'text') && sourceId) {
              const tempNodeId = createId('node');
              addNode({
                id: tempNodeId,
                nodeType: nodeType as 'note' | 'text',
                placementPoint: dropPos,
                data: {
                  ...rest,
                  label,
                  sourceId,
                  origin: payload.origin,
                  content: 'Loading...',
                },
              });

              getSource(sourceId)
                .then((fullSource) => {
                  patchNodeSilent(tempNodeId, {
                    content: fullSource.content || '',
                  });
                })
                .catch((error) => {
                  console.error('Failed to load source content:', error);
                  patchNodeSilent(tempNodeId, {
                    content: 'Failed to load content',
                  });
                });
              return;
            }

            newNodeInput = {
              nodeType: nodeType as keyof typeof nodeTypes,
              placementPoint: dropPos,
              data: {
                ...rest,
                label,
                sourceId,
                origin: payload.origin,
              },
            };
          }

          if (newNodeInput) addNode(newNodeInput);
          return;
        }

        // ============ 2. Native file drops (from desktop / Finder) ============
        const nativeFiles = Array.from(e.dataTransfer.files);
        if (nativeFiles.length > 0) {
          void (async () => {
            const inputs = (
              await Promise.all(
                nativeFiles.map(async (file, i) => {
                  const offset = i * 30;
                  const pos = {
                    x: dropPos.x + offset,
                    y: dropPos.y + offset,
                  };
                  return uploadFileToNodeInput(file, pos, {
                    type: 'user-uploaded',
                  });
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
            textToNodeInput(plainText, dropPos, { type: 'user-uploaded' }),
          );
        }
      }}
    >
      <ReactFlow
        deleteKeyCode={null}
        fitView={true}
        nodes={nodes}
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
            ? false
            : tool === 'pan'
              ? true
              : isTouch
                ? true
                : [1] /* 1 = middle mouse button */
        }
        selectionOnDrag={
          pendingNodeType ? false : isTouch ? false : tool === 'select'
        }
        nodesDraggable={!pendingNodeType}
        elementsSelectable={!pendingNodeType}
        panOnScroll={!isTouch}
        zoomOnScroll={true}
        zoomOnPinch={true}
        minZoom={0.1}
        maxZoom={5}
        onlyRenderVisibleElements
      >
        <Panel position="bottom-center" className="mb-6">
          <NodeToolbar activeTool={tool} onToolChange={setTool} />
        </Panel>
        <MultiSelectToolbar />
        <EdgeStyleToolbar />
        <IntentPopover />
        <Background color="var(--canvas-grid)" gap={GRID_SIZE} />

        <Controls position="bottom-left" />
      </ReactFlow>

      {/* Frame drag preview overlay */}
      {isDraggingFrame && frameDragRect && frameDragRect.width > 2 && (
        <div
          className="border-info bg-info-bg/40 pointer-events-none absolute z-50 rounded border-1 border-dashed"
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
    </div>
  );
};
