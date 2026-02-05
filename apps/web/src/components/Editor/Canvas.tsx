import { ReactFlow, Background, Controls } from '@xyflow/react';
import React, { useMemo } from 'react';
import '@xyflow/react/dist/style.css';

import useStore from '../../store/canvasStore.ts';
import { ImageNode } from '../Nodes/ImageNode.tsx';

export const Canvas: React.FC = () => {
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const onNodesChange = useStore((state) => state.onNodesChange);
  const onEdgesChange = useStore((state) => state.onEdgesChange);
  const onConnect = useStore((state) => state.onConnect);

  const nodeTypes = useMemo(
    () => ({
      image: ImageNode,
      // text: TextNode,
    }),
    [],
  );

  return (
    <div className="relative flex h-full w-full flex-col bg-[#f5f5f5]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        attributionPosition="bottom-right"
      >
        <Background color="#ccc" gap={18} />

        <Controls position="bottom-left" />
      </ReactFlow>
    </div>
  );
};
