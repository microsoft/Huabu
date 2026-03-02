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
import { getSource } from '../../api/knowledge';
import useCanvasStore from '../../store/canvasStore.ts';
import {
  canReadSedimentPayload,
  getSedimentPayload,
} from '../../utils/dragDrop';
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
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setRfInstance = useCanvasStore((state) => state.setRfInstance);
  const frameSelectedNodes = useCanvasStore(
    (state) => state.frameSelectedNodes,
  );
  const frameNodesInRect = useCanvasStore((state) => state.frameNodesInRect);
  const pendingNodeType = useCanvasStore((state) => state.pendingNodeType);
  const setPendingNodeType = useCanvasStore(
    (state) => state.setPendingNodeType,
  );
  const copySelectedNodes = useCanvasStore((state) => state.copySelectedNodes);
  const pasteNodes = useCanvasStore((state) => state.pasteNodes);
  const sendSelectedToOrder = useCanvasStore(
    (state) => state.sendSelectedToOrder,
  );
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);
  const lastDropRef = useRef<{ key: string; at: number } | null>(null);
  const mousePositionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

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
            data: { type: 'note', content: '' },
            style: { width: w, height: h },
          };
          break;
        case 'text':
          newNode = {
            ...baseNode,
            type: 'text',
            data: { type: 'text', content: '' },
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

  // Track mouse position globally so paste can use it
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      mousePositionRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', onMouseMove);
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, []);

  // Handle "Cmd/Ctrl + G" to create a frame from selected nodes.
  // Handle "Cmd/Ctrl + C" to copy selected nodes.
  // Handle "Cmd/Ctrl + V" to paste copied nodes.
  // Handle "Cmd/Ctrl + Z" to undo.
  // Handle "Cmd/Ctrl + Shift + Z" to redo.
  // Handle "[" to bring selected nodes to back.
  // Handle "]" to bring selected nodes to front.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key;
      const mod = e.metaKey || e.ctrlKey;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();

      // For text inputs / textareas, let the browser handle copy/paste natively
      const isNativeInput = tag === 'input' || tag === 'textarea';

      // For contentEditable / role=textbox editors (BlockNote etc.),
      // allow native copy/paste but block other shortcuts like Cmd+G
      const isRichEditor =
        target?.isContentEditable ||
        target?.getAttribute?.('role') === 'textbox';

      // [ and ] for z-order — no modifier required
      if ((key === '[' || key === '【') && !isNativeInput && !isRichEditor) {
        e.preventDefault();
        sendSelectedToOrder('bottom');
        return;
      }
      if (key === ']' || (key === '】' && !isNativeInput && !isRichEditor)) {
        e.preventDefault();
        sendSelectedToOrder('top');
        return;
      }

      if (!mod || e.altKey) return;

      const lowerKey = key.toLowerCase();

      // Cmd/Ctrl+Shift+Z → redo (must come before the shift guard)
      if (lowerKey === 'z' && e.shiftKey) {
        if (isNativeInput || isRichEditor) return;
        e.preventDefault();
        redo();
        return;
      }

      // Remaining shortcuts require Cmd/Ctrl without Shift
      if (e.shiftKey) return;

      if (lowerKey === 'z') {
        if (isNativeInput || isRichEditor) return;
        e.preventDefault();
        undo();
      } else if (lowerKey === 'g') {
        if (isNativeInput || isRichEditor) return;
        e.preventDefault();
        frameSelectedNodes();
      } else if (lowerKey === 'c') {
        if (isNativeInput || isRichEditor) return;
        e.preventDefault();
        copySelectedNodes();
      } else if (lowerKey === 'v') {
        if (isNativeInput || isRichEditor) return;
        e.preventDefault();
        // Convert current mouse screen position to flow coordinates
        const instance = rfInstanceRef.current;
        if (instance) {
          const flowPos = instance.screenToFlowPosition({
            x: mousePositionRef.current.x,
            y: mousePositionRef.current.y,
          });
          pasteNodes(flowPos);
        } else {
          pasteNodes();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    frameSelectedNodes,
    copySelectedNodes,
    pasteNodes,
    sendSelectedToOrder,
    undo,
    redo,
  ]);

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
        if (!canReadSedimentPayload(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        if (!canReadSedimentPayload(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();

        const payload = getSedimentPayload(e.dataTransfer);
        if (!payload) return;

        const instance = rfInstanceRef.current;
        if (!instance) return;

        let position: { x: number; y: number };

        // Prefer modern API when available.
        if ('screenToFlowPosition' in instance) {
          position = (instance as ReactFlowInstance).screenToFlowPosition({
            x: e.clientX,
            y: e.clientY,
          });
        } else {
          const bounds = wrapperRef.current?.getBoundingClientRect();
          const x = bounds ? e.clientX - bounds.left : e.clientX;
          const y = bounds ? e.clientY - bounds.top : e.clientY;
          // Back-compat for older XYFlow builds.
          position = (
            instance as unknown as {
              project: (p: { x: number; y: number }) => {
                x: number;
                y: number;
              };
            }
          ).project({
            x,
            y,
          });
        }

        // Some browsers/components can dispatch multiple drop events for a single gesture,
        // especially when dragging selected text. Deduplicate by dragId.
        const dedupeKey = `drag:${payload.dragId}`;

        const now =
          typeof e.timeStamp === 'number' && e.timeStamp > 0
            ? e.timeStamp
            : Date.now();
        const lastDrop = lastDropRef.current;
        const windowMs = 4000;
        if (
          lastDrop &&
          lastDrop.key === dedupeKey &&
          now - lastDrop.at < windowMs
        )
          return;
        lastDropRef.current = { key: dedupeKey, at: now };

        let newNode: Node | null = null;

        if (payload.kind === 'web') {
          newNode = {
            id: createId('node'),
            type: 'web',
            position,
            data: {
              src: payload.data.src,
            },
            style: { width: 300, height: 200 },
          };
        }

        if (payload.kind === 'note') {
          newNode = {
            id: createId('node'),
            type: 'note',
            position,
            data: {
              content: payload.data.content,
              ...(payload.data.contentJson
                ? { contentJson: payload.data.contentJson }
                : {}),
            },
          };
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
            ...rest,
          };

          // Map specific fields for node types
          if (nodeType === 'web') {
            data.src = rest.src;
          }
          if (nodeType === 'pdf') {
            data.src = rest.src;
          }

          // For note/text nodes, we need to fetch the full content
          // because SourceOverview doesn't include content
          if ((nodeType === 'note' || nodeType === 'text') && sourceId) {
            // Create node with loading state first
            const tempNode: Node = {
              id: createId('node'),
              type: nodeType,
              position,
              data: {
                ...data,
                content: 'Loading...',
              },
            };
            addNode(tempNode);

            // Fetch full source content asynchronously
            getSource(sourceId)
              .then((fullSource) => {
                updateNodeData(tempNode.id, {
                  content: fullSource.content || '',
                });
              })
              .catch((error) => {
                console.error('Failed to load source content:', error);
                updateNodeData(tempNode.id, {
                  content: 'Failed to load content',
                });
              });

            return; // Exit early since we've already added the node
          }

          newNode = {
            id: createId('node'),
            type: nodeType,
            position,
            data,
            style: nodeType === 'web' ? { width: 300, height: 200 } : undefined,
          };
        }

        if (!newNode) return;
        addNode(newNode);
      }}
    >
      <ReactFlow
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
        panOnScroll={true}
        zoomOnScroll={true}
        minZoom={0.1}
        maxZoom={5}
        onlyRenderVisibleElements
      >
        <Panel position="bottom-center" className="mb-6">
          <NodeToolbar activeTool={tool} onToolChange={setTool} />
        </Panel>
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
