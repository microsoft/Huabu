import { type Node, type NodeProps } from '@xyflow/react';
import { Layers, Ungroup, Lock } from 'lucide-react';

import { NodeWrapper, type NodeDataProps } from './NodeWrapper.tsx';

type GroupNodeData = NodeDataProps & {};
export type GroupNodeType = Node<GroupNodeData, 'group'>;

export const GroupNode = ({ id, data, selected }: NodeProps<GroupNodeType>) => {
  const GroupToolbar = (
    <div className="flex w-full items-center justify-between gap-4">
      {/* Label */}
      <div className="text-muted-foreground flex flex-1 items-center gap-2 text-xs font-medium">
        <Layers size={12} />
        <span className="truncate">{data.label || 'Group'}</span>
      </div>

      {/* Tools */}
      <div className="text-muted-foreground flex items-center gap-2">
        <div className="bg-border h-3 w-px" />

        <button className="hover:text-main" title="Ungroup">
          <Ungroup size={12} />
        </button>
        <button className="hover:text-main" title="Lock">
          <Lock size={12} />
        </button>
      </div>
    </div>
  );

  return (
    <NodeWrapper
      id={id}
      data={data}
      selected={selected}
      toolbar={GroupToolbar}
      keepAspectRatio={false}
      className="!border-dashed !border-gray-300 !bg-gray-50/30"
    >
      <div className="relative h-full w-full p-2">
        <span className="text-muted-foreground/20 pointer-events-none absolute right-4 bottom-2 text-4xl font-bold opacity-10 select-none">
          GROUP
        </span>
      </div>
    </NodeWrapper>
  );
};
