import { useMemo } from 'react';

import useCanvasStore from '@/store/canvasStore';

/**
 * Compact indicator showing how many canvas nodes are currently selected.
 * Displayed next to the send button so the user knows which nodes will
 * be included as context in the conversation.
 */
export const SourceCount = () => {
  const nodes = useCanvasStore((s) => s.nodes);

  const count = useMemo(() => nodes.filter((n) => n.selected).length, [nodes]);

  if (count === 0) return null;

  return (
    <span className="text-muted-foreground inline-flex items-center gap-1 text-sm leading-tight">
      <span>{count}</span>
      <span>{count === 1 ? 'source' : 'sources'}</span>
    </span>
  );
};
