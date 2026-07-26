import { Pin } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { NodeWrapper } from '@/components/Nodes/NodeWrapper';
import useCanvasStore from '@/store/canvasStore';

import type { NodeRefNodeData } from '@/components/Nodes/types';
import type { Node, NodeProps } from '@xyflow/react';

export type NodeRefNodeType = Node<NodeRefNodeData, 'nodeRef'>;

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

export const NodeRefNode = memo(
  ({ id, data, selected }: NodeProps<NodeRefNodeType>) => {
    const { t } = useTranslation();
    const resolved = useCanvasStore((state) => state.worldReferences[id]);
    const resolutionError = useCanvasStore(
      (state) => state.worldReferenceError,
    );
    const source = resolved?.kind === 'nodeRef' ? resolved.source : undefined;
    const status = resolved?.kind === 'nodeRef' ? resolved.status : undefined;
    return (
      <NodeWrapper id={id} data={data} type="nodeRef" selected={selected}>
        <div className="flex h-full w-full flex-col justify-center gap-2 px-4">
          <div className="text-fg-muted flex items-center gap-2 text-sm font-medium">
            <Pin size={16} />
            {resolutionError
              ? t('world.loadFailed')
              : status === 'canvas-missing'
                ? t('world.missingSpace')
                : status === 'node-missing'
                  ? t('world.missingNode')
                  : source?.label || t('world.pinnedNode')}
          </div>
          <div className="text-fg-subtle truncate text-xs">
            {source
              ? `${source.type}${source.summary ? ` · ${source.summary}` : ''}`
              : shortId(data.target.nodeId)}
          </div>
        </div>
      </NodeWrapper>
    );
  },
);

NodeRefNode.displayName = 'NodeRefNode';
