import { createId } from '@sediment/shared';
import {
  ReactFlow,
  Background,
  Controls,
  type ReactFlowInstance,
  type Node,
} from '@xyflow/react';
import React, { useMemo, useRef } from 'react';
import '@xyflow/react/dist/style.css';

import useStore from '../../store/canvasStore.ts';
import {
  canReadSedimentPayload,
  getSedimentPayload,
} from '../../utils/dragDrop';
import { GroupNode } from '../Nodes/GroupNode.tsx';
import { ImageNode } from '../Nodes/ImageNode.tsx';
import { NoteNode } from '../Nodes/NoteNode.tsx';
import { PDFNode } from '../Nodes/PDFNode.tsx';
import { TextNode } from '../Nodes/TextNode.tsx';
import { VideoNode } from '../Nodes/VideoNode.tsx';
import { WebNode } from '../Nodes/WebNode.tsx';

export const Canvas: React.FC = () => {
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const onNodesChange = useStore((state) => state.onNodesChange);
  const onEdgesChange = useStore((state) => state.onEdgesChange);
  const onConnect = useStore((state) => state.onConnect);
  const setNodes = useStore((state) => state.setNodes);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);

  const nodeTypes = useMemo(
    () => ({
      image: ImageNode,
      text: TextNode,
      note: NoteNode,
      video: VideoNode,
      web: WebNode,
      pdf: PDFNode,
      group: GroupNode,
    }),
    [],
  );

  return (
    <div
      ref={wrapperRef}
      className="bg-background relative flex h-full w-full flex-col"
      onDragOver={(e) => {
        if (!canReadSedimentPayload(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        if (!canReadSedimentPayload(e.dataTransfer)) return;
        e.preventDefault();

        const payload = getSedimentPayload(e.dataTransfer);
        if (!payload) return;

        const instance = rfInstanceRef.current;
        if (!instance) return;

        let position = { x: 0, y: 0 };

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

        let newNode: Node | null = null;

        if (payload.kind === 'web') {
          newNode = {
            id: createId('node'),
            type: 'web',
            position,
            data: {
              src: payload.data.src,
            },
            style: { width: 460, height: 300 },
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
            style: { width: 220, height: 220 },
          };
        }

        if (!newNode) return;
        setNodes([...nodes, newNode]);
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
        }}
        fitView
        attributionPosition="bottom-right"
      >
        <Background color="#ccc" gap={18} />

        <Controls position="bottom-left" />
      </ReactFlow>
    </div>
  );
};
