import {
  ReactFlow,
  Background,
  Controls,
  type ReactFlowInstance,
  type Node,
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

import { NodeToolbar } from './CanvasToolbar';
import { IntentPopover } from './IntentPopover';
import { MultiSelectToolbar } from './MultiSelectToolbar';
import { uploadImage, uploadPdf, uploadVideo } from '../../api/artifact';
import { getSource } from '../../api/knowledge';
import { GRID_SIZE } from '../../config/canvas';
import { useCanvasShortcuts } from '../../hooks/useCanvasShortcuts';
import useCanvasStore from '../../store/canvasStore.ts';
import {
  canReadSedimentPayload,
  getSedimentPayload,
} from '../../utils/io/dragDrop';
import {
  detectNodeType,
  detectNodeTypeFromMime,
  looksLikeUrl,
  normalizeUrl,
  getImageDimensionsFromBlob,
} from '../../utils/io/media';
import { buildNode, buildSourceNode } from '../../utils/node/factory';
import { FrameNode } from '../Nodes/FrameNode';
import { ImageNode } from '../Nodes/ImageNode';
import { NoteNode } from '../Nodes/NoteNode';
import { PDFNode } from '../Nodes/PDFNode';
import { TextNode } from '../Nodes/TextNode';
import { VideoNode } from '../Nodes/VideoNode';
import { WebNode } from '../Nodes/WebNode';

import type { FrameFitPreview } from '../../store/canvasStore.ts';

const nodeTypes = {
  image: ImageNode,
  text: TextNode,
  note: NoteNode,
  video: VideoNode,
  web: WebNode,
  pdf: PDFNode,
  frame: FrameNode,
} as const;

const VALID_NODE_TYPES = Object.keys(nodeTypes);

/**
 * Renders a dashed-border preview overlay showing the target frame size
 * when a node is being dragged near or inside a frame.
 */
const FrameFitPreviewOverlay: React.FC<{
  preview: FrameFitPreview;
  rfInstance: ReactFlowInstance | null;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
}> = React.memo(({ preview, rfInstance, wrapperRef }) => {
  const screenRect = useMemo(() => {
    if (!rfInstance || !wrapperRef.current) return null;

    const topLeft = rfInstance.flowToScreenPosition({
      x: preview.x,
      y: preview.y,
    });
    const bottomRight = rfInstance.flowToScreenPosition({
      x: preview.x + preview.width,
      y: preview.y + preview.height,
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
      className="bg-theme-100/15 shadow-bottom pointer-events-none absolute z-40 transition-all duration-150"
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

export const Canvas: React.FC = () => {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const onConnect = useCanvasStore((state) => state.onConnect);
  const onNodeDragStart = useCanvasStore((state) => state.onNodeDragStart);
  const onNodeDrag = useCanvasStore((state) => state.onNodeDrag);
  const onNodeDragStop = useCanvasStore((state) => state.onNodeDragStop);
  const frameFitPreviews = useCanvasStore((state) => state.frameFitPreviews);
  const addNode = useCanvasStore((state) => state.addNode);
  const patchNodeSilent = useCanvasStore((state) => state.patchNodeSilent);
  const setRfInstance = useCanvasStore((state) => state.setRfInstance);
  const openExpanded = useCanvasStore((state) => state.openExpanded);
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
  const { tool, setTool } = useCanvasShortcuts({
    rfInstanceRef,
    mousePositionRef,
  });

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

  // Cancel pending node placement with Escape key
  useEffect(() => {
    if (!pendingNodeType) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPendingNodeType(null);
        setFrameDragStart(null);
        setFrameDragEnd(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingNodeType, setPendingNodeType]);

  // Handle click-to-place for note and text
  const handlePaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (!pendingNodeType || pendingNodeType === 'frame') return;
      const instance = rfInstanceRef.current;
      if (!instance) return;

      const position = instance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode = buildNode({
        type: pendingNodeType,
        position,
        data: {
          content: '',
          origin: { type: 'user-created' },
        },
      });

      addNode(newNode, true);
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
        setFrameDragStart(null);
        setFrameDragEnd(null);
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

      setFrameDragStart(null);
      setFrameDragEnd(null);
      setPendingNodeType(null);
    },
    [
      isDraggingFrame,
      frameDragStart,
      frameDragEnd,
      frameNodesInRect,
      setPendingNodeType,
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
        'bg-background relative flex h-full w-full flex-col',
        pendingNodeType === 'note' && 'canvas-pending-note',
        pendingNodeType === 'text' && 'canvas-pending-text',
        pendingNodeType === 'frame' && 'canvas-pending-frame',
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

          let newNode: Node | null = null;

          if (payload.kind === 'web') {
            newNode = buildNode({
              type: 'web',
              position: dropPos,
              data: { src: payload.data.src, origin: payload.origin },
            });
          }

          if (payload.kind === 'note') {
            newNode = buildNode({
              type: 'note',
              position: dropPos,
              data: {
                content: payload.data.content,
                ...(payload.data.contentJson
                  ? { contentJson: payload.data.contentJson }
                  : {}),
                origin: payload.origin,
              },
            });
          }

          if (payload.kind === 'image') {
            const { src, label } = payload.data;

            const doAdd = (natW: number, natH: number) => {
              addNode(
                buildNode({
                  type: 'image',
                  position: dropPos,
                  data: { src, label, origin: payload.origin },
                  naturalDimensions: { width: natW, height: natH },
                }),
              );
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
              const tempNode = buildNode({
                type: nodeType,
                position: dropPos,
                data: {
                  ...rest,
                  label,
                  sourceId,
                  origin: payload.origin,
                  content: 'Loading...',
                },
              });
              addNode(tempNode);

              getSource(sourceId)
                .then((fullSource) => {
                  patchNodeSilent(tempNode.id, {
                    content: fullSource.content || '',
                  });
                })
                .catch((error) => {
                  console.error('Failed to load source content:', error);
                  patchNodeSilent(tempNode.id, {
                    content: 'Failed to load content',
                  });
                });
              return;
            }

            newNode = buildSourceNode({
              sourceId,
              sourceType: type,
              position: dropPos,
              origin: payload.origin,
              extra: { ...rest, label },
              validNodeTypes: VALID_NODE_TYPES,
            });
          }

          if (newNode) addNode(newNode);
          return;
        }

        // ============ 2. Native file drops (from desktop / Finder) ============
        const nativeFiles = Array.from(e.dataTransfer.files);
        if (nativeFiles.length > 0) {
          void (async () => {
            for (let i = 0; i < nativeFiles.length; i++) {
              const file = nativeFiles[i];
              const fileType = file.type
                ? detectNodeTypeFromMime(file.type)
                : detectNodeType(file.name);
              const offset = i * 30;
              const pos = { x: dropPos.x + offset, y: dropPos.y + offset };

              try {
                if (fileType === 'image') {
                  const [url, dims] = await Promise.all([
                    uploadImage(file),
                    getImageDimensionsFromBlob(file),
                  ]);
                  addNode(
                    buildNode({
                      type: 'image',
                      position: pos,
                      data: {
                        src: url,
                        label: file.name,
                        origin: { type: 'user-uploaded' },
                      },
                      naturalDimensions: dims,
                    }),
                  );
                } else if (fileType === 'video') {
                  const url = await uploadVideo(file);
                  addNode(
                    buildNode({
                      type: 'video',
                      position: pos,
                      data: {
                        src: url,
                        label: file.name,
                        origin: { type: 'user-uploaded' },
                      },
                    }),
                  );
                } else if (fileType === 'pdf') {
                  const url = await uploadPdf(file);
                  addNode(
                    buildNode({
                      type: 'pdf',
                      position: pos,
                      data: {
                        src: url,
                        label: file.name,
                        origin: { type: 'user-uploaded' },
                      },
                    }),
                  );
                }
              } catch (error) {
                console.error(`Failed to drop file ${file.name}:`, error);
              }
            }
          })();
          return;
        }

        // ============ 3. URL drop (browser address bar, link drag) ============
        const uriList = e.dataTransfer.getData('text/uri-list');
        const plainText = e.dataTransfer.getData('text/plain');
        const droppedUrl = (uriList || plainText || '').trim();

        if (droppedUrl && looksLikeUrl(droppedUrl)) {
          const finalUrl = normalizeUrl(droppedUrl);
          const nodeType = detectNodeType(finalUrl);
          addNode(
            buildNode({
              type: nodeType,
              position: dropPos,
              data: {
                src: finalUrl,
                origin: { type: 'user-uploaded' },
              },
            }),
          );
          return;
        }

        // ============ 4. Plain text drop ============
        if (plainText) {
          addNode(
            buildNode({
              type: 'note',
              position: dropPos,
              data: {
                content: plainText,
                origin: { type: 'user-uploaded' },
              },
            }),
          );
        }
      }}
    >
      <ReactFlow
        deleteKeyCode={null}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
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
        fitView
        attributionPosition="bottom-right"
        panOnDrag={
          pendingNodeType
            ? false
            : tool === 'pan'
              ? true
              : [1] /* 1 = middle mouse button */
        }
        selectionOnDrag={pendingNodeType ? false : tool === 'select'}
        nodesDraggable={!pendingNodeType}
        elementsSelectable={!pendingNodeType}
        panOnScroll={true}
        zoomOnScroll={true}
        minZoom={0.1}
        maxZoom={5}
        onlyRenderVisibleElements
      >
        <Panel position="bottom-center" className="mb-6">
          <NodeToolbar activeTool={tool} onToolChange={setTool} />
        </Panel>
        <MultiSelectToolbar />
        <IntentPopover />
        <Background color="#ccc" gap={GRID_SIZE} />

        <Controls position="bottom-left" />
      </ReactFlow>

      {/* Frame drag preview overlay */}
      {isDraggingFrame && frameDragRect && frameDragRect.width > 2 && (
        <div
          className="border-theme-500 bg-theme-50/30 pointer-events-none absolute z-50 rounded border-2 border-dashed"
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
