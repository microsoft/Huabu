import { ReactFlow, Background, Controls, MiniMap } from '@xyflow/react';
import React from 'react';
import '@xyflow/react/dist/style.css';

import useStore from '../../store/store.ts';

export const Canvas: React.FC = () => {
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const onNodesChange = useStore((state) => state.onNodesChange);
  const onEdgesChange = useStore((state) => state.onEdgesChange);
  const onConnect = useStore((state) => state.onConnect);

  return (
    <div className="relative flex h-full w-full flex-col bg-gray-50">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView // 初始化时自动适配视图
        attributionPosition="bottom-right"
      >
        {/* 背景网格 */}
        <Background color="#ccc" gap={20} />

        {/* 左下角控制栏 (放大缩小等) */}
        <Controls position="bottom-left" />

        {/* 右下角小地图 (可选) */}
        <MiniMap position="bottom-right" className="!bottom-10" />
      </ReactFlow>
    </div>
  );
};
