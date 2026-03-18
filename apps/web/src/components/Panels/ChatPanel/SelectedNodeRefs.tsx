import { useMemo } from 'react';

import { Tooltip } from '@/components/Common/Tooltip';
import useCanvasStore from '@/store/canvasStore';

/**
 * Compact indicator showing how many canvas nodes are currently selected.
 * Displayed next to the send button so the user knows which nodes will
 * be included as context in the conversation.
 * Hovering reveals the names of the selected nodes.
 */
export const SourceCount = () => {
  const nodes = useCanvasStore((s) => s.nodes);

  const selectedNodes = useMemo(() => nodes.filter((n) => n.selected), [nodes]);

  const count = selectedNodes.length;

  if (count === 0) return null;

  const tooltipContent = (
    <div className="flex flex-col gap-0.5">
      {selectedNodes.map((n) => {
        const label = (n.data as Record<string, unknown> | undefined)?.label as
          | string
          | undefined;
        return (
          <span key={n.id} className="text-xs">
            {label || n.type || 'Untitled'}
          </span>
        );
      })}
    </div>
  );

  return (
    <Tooltip content={tooltipContent}>
      <span className="text-muted-foreground inline-flex cursor-default items-center gap-1 text-sm leading-tight">
        <span>{count}</span>
        <span>{count === 1 ? 'source' : 'sources'}</span>
      </span>
    </Tooltip>
  );
};
