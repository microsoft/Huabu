import { createId } from '@sediment/shared';
import {
  ReactFlow,
  Background,
  Controls,
  type ReactFlowInstance,
  type Node,
  Panel,
} from '@xyflow/react';
import clsx from 'clsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import '@xyflow/react/dist/style.css';

import { NodeToolbar } from './CanvasToolbar';
import { IntentPopover } from './IntentPopover';
import { MultiSelectToolbar } from './MultiSelectToolbar';
import { uploadImage, uploadPdf, uploadVideo } from '../../api/artifact';
import { getSource } from '../../api/knowledge';
import { useCanvasShortcuts } from '../../hooks/useCanvasShortcuts';
import useCanvasStore from '../../store/canvasStore.ts';
import {
  canReadSedimentPayload,
  getSedimentPayload,
} from '../../utils/dragDrop';
import {
  detectNodeType,
  detectNodeTypeFromMime,
  looksLikeUrl,
  normalizeUrl,
  getImageDimensionsFromBlob,
} from '../../utils/mediaUtils';
import { FrameNode } from '../Nodes/FrameNode';
import { ImageNode } from '../Nodes/ImageNode';
import { NoteNode } from '../Nodes/NoteNode';
import { PDFNode } from '../Nodes/PDFNode';
import { TextNode } from '../Nodes/TextNode';
import { VideoNode } from '../Nodes/VideoNode';
import { WebNode } from '../Nodes/WebNode';

const nodeTypes = {
  image: ImageNode,
  text: TextNode,
  note: NoteNode,
  video: VideoNode,
  web: WebNode,
  pdf: PDFNode,
  frame: FrameNode,
} as const;

export const Canvas: React.FC = () => {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const onConnect = useCanvasStore((state) => state.onConnect);
  const onNodeDragStart = useCanvasStore((state) => state.onNodeDragStart);
  const onNodeDragStop = useCanvasStore((state) => state.onNodeDragStop);
  const addNode = useCanvasStore((state) => state.addNode);
  const patchNodeSilent = useCanvasStore((state) => state.patchNodeSilent);
  const setRfInstance = useCanvasStore((state) => state.setRfInstance);
  const frameNodesInRect = useCanvasStore((state) => state.frameNodesInRect);
  const pendingNodeType = useCanvasStore((state) => state.pendingNodeType);
  const setPendingNodeType = useCanvasStore(
    (state) => state.setPendingNodeType,
  );

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);
  const lastDropRef = useRef<{ key: string; at: number } | null>(null);
  const mousePositionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Keyboard shortcuts + paste handler (extracted to hook)
  useCanvasShortcuts({ rfInstanceRef, mousePositionRef });

  const [tool, setTool] = useState<'select' | 'pan'>('select');

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

      const w = 400;
      const h = 300;

      // Centre the node at the click position
      // Text nodes auto-size so use a small estimate for centering
      const isText = pendingNodeType === 'text';
      const centeredPosition = {
        x: position.x - (isText ? 15 : w / 2),
        y: position.y - (isText ? 12 : h / 2),
      };

      const baseNode = {
        id: createId('node'),
        position: centeredPosition,
      };

      let newNode: Node;

      switch (pendingNodeType) {
        case 'note':
          newNode = {
            ...baseNode,
            type: 'note',
            data: {
              type: 'note',
              content: '',
              origin: { type: 'user-created' },
            },
            style: { width: w, height: h },
          };
          break;
        case 'text':
          newNode = {
            ...baseNode,
            type: 'text',
            data: {
              type: 'text',
              content: '',
              origin: { type: 'user-created' },
            },
          };
          break;
        default:
          return;
      }

      addNode(newNode);
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

        /** Center a node of known size at the given point. */
        const cent = (pos: { x: number; y: number }, w: number, h: number) => ({
          x: pos.x - w / 2,
          y: pos.y - h / 2,
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
            const W = 300,
              H = 200;
            newNode = {
              id: createId('node'),
              type: 'web',
              position: cent(dropPos, W, H),
              data: { src: payload.data.src, origin: payload.origin },
              style: { width: W, height: H },
            };
          }

          if (payload.kind === 'note') {
            const W = 400,
              H = 300;
            newNode = {
              id: createId('node'),
              type: 'note',
              position: cent(dropPos, W, H),
              data: {
                content: payload.data.content,
                ...(payload.data.contentJson
                  ? { contentJson: payload.data.contentJson }
                  : {}),
                origin: payload.origin,
              },
              style: { width: W, height: H },
            };
          }

          if (payload.kind === 'image') {
            const FIXED_WIDTH = 300;
            const nodeId = createId('node');
            const { src, label } = payload.data;

            const doAdd = (height: number) => {
              addNode({
                id: nodeId,
                type: 'image',
                position: cent(dropPos, FIXED_WIDTH, height),
                data: { src, label, origin: payload.origin },
                style: { width: FIXED_WIDTH, height },
              });
            };

            const img = new Image();
            img.onload = () => {
              const height =
                img.naturalWidth > 0
                  ? Math.round(
                      FIXED_WIDTH * (img.naturalHeight / img.naturalWidth),
                    )
                  : 200;
              doAdd(height);
            };
            img.onerror = () => doAdd(200);
            img.src = src;
            return;
          }

          if (payload.kind === 'source') {
            const { type, sourceId, label, ...rest } = payload.data;

            let nodeType = 'text';
            if (typeof type === 'string' && type in nodeTypes) {
              nodeType = type;
            }

            const data: Record<string, unknown> = {
              label,
              sourceId,
              origin: payload.origin,
              ...rest,
            };

            if (nodeType === 'web') data.src = rest.src;
            if (nodeType === 'pdf') data.src = rest.src;

            if ((nodeType === 'note' || nodeType === 'text') && sourceId) {
              const W = 400,
                H = 300;
              const tempNode: Node = {
                id: createId('node'),
                type: nodeType,
                position: cent(dropPos, W, H),
                data: { ...data, content: 'Loading...' },
                style: { width: W, height: H },
              };
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

            const W = nodeType === 'web' ? 300 : 400;
            const H = nodeType === 'web' ? 200 : 300;
            newNode = {
              id: createId('node'),
              type: nodeType,
              position: cent(dropPos, W, H),
              data,
              style: { width: W, height: H },
            };
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
                  const W = 300;
                  const H =
                    dims.width > 0
                      ? Math.round(W * (dims.height / dims.width))
                      : 200;
                  addNode({
                    id: createId('node'),
                    type: 'image',
                    position: cent(pos, W, H),
                    data: {
                      type: 'image',
                      src: url,
                      label: file.name,
                      origin: { type: 'user-uploaded' },
                    },
                    style: { width: W, height: H },
                  });
                } else if (fileType === 'video') {
                  const url = await uploadVideo(file);
                  const W = 400,
                    H = 300;
                  addNode({
                    id: createId('node'),
                    type: 'video',
                    position: cent(pos, W, H),
                    data: {
                      type: 'video',
                      src: url,
                      label: file.name,
                      origin: { type: 'user-uploaded' },
                    },
                    style: { width: W, height: H },
                  });
                } else if (fileType === 'pdf') {
                  const url = await uploadPdf(file);
                  const W = 400,
                    H = 300;
                  addNode({
                    id: createId('node'),
                    type: 'pdf',
                    position: cent(pos, W, H),
                    data: {
                      type: 'pdf',
                      src: url,
                      label: file.name,
                      origin: { type: 'user-uploaded' },
                    },
                    style: { width: W, height: H },
                  });
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
          const W = nodeType === 'image' ? 300 : 400;
          const H = nodeType === 'image' ? 200 : 300;
          let label: string | undefined;
          try {
            label = new URL(finalUrl).hostname;
          } catch {
            /* ignore */
          }
          addNode({
            id: createId('node'),
            type: nodeType,
            position: cent(dropPos, W, H),
            data: {
              type: nodeType,
              src: finalUrl,
              ...(label ? { label } : {}),
              origin: { type: 'user-uploaded' },
            },
            style: { width: W, height: H },
          });
          return;
        }

        // ============ 4. Plain text drop ============
        if (plainText) {
          const trimmed = plainText.trim();
          const firstLine =
            trimmed
              .split('\n')
              .find((l) => l.trim())
              ?.trim()
              .slice(0, 50) || undefined;
          const W = 400,
            H = 300;
          addNode({
            id: createId('node'),
            type: 'note',
            position: cent(dropPos, W, H),
            data: {
              type: 'note',
              content: plainText,
              ...(firstLine ? { label: firstLine } : {}),
              origin: { type: 'user-uploaded' },
            },
            style: { width: W, height: H },
          });
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
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        onInit={(instance) => {
          rfInstanceRef.current = instance;
          setRfInstance(instance);
        }}
        onPaneClick={handlePaneClick}
        onNodeDoubleClick={(e) => e.stopPropagation()}
        fitView
        attributionPosition="bottom-right"
        panOnDrag={pendingNodeType ? false : tool === 'pan'}
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
        <Background color="#ccc" gap={18} />

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
    </div>
  );
};
