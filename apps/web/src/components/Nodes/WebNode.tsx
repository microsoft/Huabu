import { type Node, type NodeProps } from '@xyflow/react';
import { Globe, RotateCw, ExternalLink } from 'lucide-react';

import { NodeWrapper, type NodeDataProps } from './NodeWrapper.tsx';

type WebNodeData = NodeDataProps & {};
export type WebNodeType = Node<WebNodeData, 'web'>;

export const WebNode = ({ id, data, selected }: NodeProps<WebNodeType>) => {
  const WebToolbar = (
    <div className="flex w-full items-center justify-between gap-4">
      {/* URL Display */}
      <div className="text-secondary flex flex-1 items-center gap-1 overflow-hidden text-xs font-medium">
        <Globe size={12} />
        <span className="truncate">{data?.src || 'No URL'}</span>
      </div>

      {/* Tools */}
      <div className="text-secondary flex items-center gap-2">
        <div className="bg-border h-3 w-px" />

        <button className="hover:text-main" title="Refresh">
          <RotateCw size={12} />
        </button>

        <a
          href={data?.src}
          target="_blank"
          rel="noreferrer"
          className="hover:text-main"
          title="Open in Browser"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );

  return (
    <NodeWrapper
      id={id}
      data={data}
      selected={selected}
      toolbar={WebToolbar}
      keepAspectRatio={false}
    >
      <div className="flex h-full flex-col">
        <div className="relative h-full w-full overflow-hidden rounded bg-white">
          {data?.src ? (
            <iframe
              src={data.src}
              className="nodrag h-full w-full"
              title="Web Preview"
              sandbox="allow-scripts allow-same-origin"
            />
          ) : (
            <div className="text-secondary flex h-full w-full items-center justify-center text-sm">
              Invalid URL
            </div>
          )}
        </div>
      </div>
    </NodeWrapper>
  );
};
