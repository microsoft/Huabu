import { Pin } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { NodeWrapper } from '@/components/Nodes/NodeWrapper';

import type { NodeRefNodeData } from '@/components/Nodes/types';
import type { Node, NodeProps } from '@xyflow/react';

export type NodeRefNodeType = Node<NodeRefNodeData, 'nodeRef'>;

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

export const NodeRefNode = memo(
  ({ id, data, selected }: NodeProps<NodeRefNodeType>) => {
    const { t } = useTranslation();
    return (
      <NodeWrapper
        id={id}
        data={data}
        type="nodeRef"
        selected={selected}
        resizable={false}
      >
        <div className="flex h-full w-full flex-col justify-center gap-2 px-4">
          <div className="text-fg-muted flex items-center gap-2 text-sm font-medium">
            <Pin size={16} />
            {t('world.pinnedNode')}
          </div>
          <div className="text-fg-subtle truncate text-xs">
            {shortId(data.target.nodeId)}
          </div>
        </div>
      </NodeWrapper>
    );
  },
);

NodeRefNode.displayName = 'NodeRefNode';
