import { type Node, type NodeProps } from '@xyflow/react';
import { Globe, RotateCw, ExternalLink, Fullscreen } from 'lucide-react';

import { NodeWrapper, type NodeDataProps } from './NodeWrapper.tsx';
import useStore from '../../store/canvasStore.ts';
import { GhostButton } from '../Common/GhostButton.tsx';

type WebNodeData = NodeDataProps & {};
export type WebNodeType = Node<WebNodeData, 'web'>;

export const WebNode = ({ id, data, selected }: NodeProps<WebNodeType>) => {
  const openExpanded = useStore((s) => s.openExpanded);
  const WebToolbar = (
    <div className="flex w-full items-center justify-between gap-4">
      {/* URL Display */}
      <div className="text-muted-foreground flex flex-1 items-center gap-1 overflow-hidden text-xs font-medium">
        <Globe size={12} />
        <span className="truncate">{data?.src || 'No URL'}</span>
      </div>

      {/* Tools */}
      <div className="text-muted-foreground flex items-center gap-2">
        <div className="bg-border h-3 w-px" />

        <GhostButton
          aria-label="Open large view"
          title="Open Large View"
          onClick={(e) => {
            e.stopPropagation();
            openExpanded(id);
          }}
        >
          <Fullscreen size={12} />
        </GhostButton>

        <GhostButton aria-label="Refresh" title="Refresh">
          <RotateCw size={12} />
        </GhostButton>

        <a
          href={data?.src}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in browser"
          className="hover:text-main hover:bg-background inline-flex cursor-pointer items-center justify-center rounded border-none bg-transparent p-1 transition-colors"
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
      onDoubleClick={(e) => {
        e.stopPropagation();
        openExpanded(id);
      }}
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
            <div className="text-muted-foreground flex h-full w-full items-center justify-center text-sm">
              Invalid URL
            </div>
          )}
        </div>
      </div>
    </NodeWrapper>
  );
};
