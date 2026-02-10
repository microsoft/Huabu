import { type Node, type NodeProps } from '@xyflow/react';
import {
  Globe,
  RotateCw,
  ExternalLink,
  Fullscreen,
  ArrowUpRight,
} from 'lucide-react';
import { useState, useCallback } from 'react';

import { NodeWrapper } from './NodeWrapper.tsx';
import useCanvasStore from '../../store/canvasStore.ts';
import { GhostButton } from '../Common/GhostButton.tsx';

import type { NodeDataProps } from './types.ts';

type WebNodeData = NodeDataProps & {};
export type WebNodeType = Node<WebNodeData, 'web'>;

export const WebNode = ({ id, data, selected }: NodeProps<WebNodeType>) => {
  const openExpanded = useCanvasStore((s) => s.openExpanded);

  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setRefreshKey((prev) => prev + 1);
  }, []);

  const WebToolbar = (
    <div className="flex w-full items-center justify-between gap-2">
      <a
        href={data?.src}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="nodrag text-muted-foreground hover:text-theme-500 flex flex-1 cursor-pointer items-center gap-1 overflow-hidden text-xs font-medium transition-colors"
      >
        <Globe size={14} />
        <span className="max-w-24 truncate">{data?.src || 'Website'}</span>
        <ArrowUpRight size={14} strokeWidth={2} />
      </a>

      <div className="text-muted-foreground flex items-center gap-1">
        <div className="bg-border h-3 w-px" />

        <GhostButton
          aria-label="Open large view"
          title="Open Large View"
          onClick={(e) => {
            e.stopPropagation();
            openExpanded(id);
          }}
        >
          <Fullscreen size={14} />
        </GhostButton>

        <GhostButton
          aria-label="Refresh"
          title="Refresh"
          onClick={handleRefresh}
        >
          <RotateCw size={14} />
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
          <ExternalLink size={14} />
        </a>
      </div>
    </div>
  );

  return (
    <NodeWrapper
      id={id}
      data={data}
      type={'web'}
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
            <>
              <iframe
                key={refreshKey}
                src={data.src}
                className="h-full w-full border-0"
                title="Web Preview"
                sandbox="allow-scripts allow-same-origin allow-forms"
                loading="lazy"
              />

              <div className="absolute inset-0 z-10 bg-transparent" />
            </>
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
