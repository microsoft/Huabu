import { createId } from '@sediment/shared';
import {
  ReactFlow,
  Background,
  Controls,
  type ReactFlowInstance,
  type Node,
  Panel,
} from '@xyflow/react';
import React, { useEffect, useRef, useState } from 'react';
import '@xyflow/react/dist/style.css';

import { NodeToolbar } from './CanvasToolbar';
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
  const addNode = useCanvasStore((state) => state.addNode);
  const setRfInstance = useCanvasStore((state) => state.setRfInstance);
  const frameSelectedNodes = useCanvasStore(
    (state) => state.frameSelectedNodes,
  );

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);
  const lastDropRef = useRef<{ key: string; at: number } | null>(null);

  const [tool, setTool] = useState<'select' | 'pan'>('select');

  // Handle "Cmd/Ctrl + G" to create a frame from selected nodes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const isGroup = key === 'g' && (e.metaKey || e.ctrlKey);
      if (!isGroup || e.shiftKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTypingContext =
        tag === 'input' ||
        tag === 'textarea' ||
        target?.isContentEditable ||
        target?.getAttribute?.('role') === 'textbox';
      if (isTypingContext) return;

      e.preventDefault();
      frameSelectedNodes();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [frameSelectedNodes]);

  return (
    <div
      ref={wrapperRef}
      className="bg-background relative flex h-full w-full flex-col"
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
          };
        }

        if (payload.kind === 'note') {
          newNode = {
            id: createId('node'),
            type: 'note',
            position,
            data: {
              content: payload.data.content,
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

          newNode = {
            id: createId('node'),
            type: nodeType,
            position,
            data,
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
        nodeTypes={nodeTypes}
        onInit={(instance) => {
          rfInstanceRef.current = instance;
          setRfInstance(instance);
        }}
        fitView
        attributionPosition="bottom-right"
        panOnDrag={tool === 'pan'}
        selectionOnDrag={tool === 'select'}
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
    </div>
  );
};
