import { NODE_ICON } from '../../config/nodeIcons';
import useCanvasStore from '../../store/canvasStore';

import type { CanvasNodeType } from '@sediment/shared';

interface NodeRefProps {
  nodeId: string;
  fallbackLabel?: string;
}

/**
 * Clickable node reference – icon + label in a bordered badge.
 * Clicking focuses the node on the canvas.
 */
export function NodeRef({ nodeId, fallbackLabel }: NodeRefProps) {
  const nodes = useCanvasStore((s) => s.nodes);
  const selectNodes = useCanvasStore((s) => s.selectNodes);
  const rfInstance = useCanvasStore((s) => s.rfInstance);

  const node = nodes.find((n) => n.id === nodeId);
  const nodeData = node?.data as Record<string, unknown> | undefined;
  const label =
    (nodeData?.label as string) ?? fallbackLabel ?? nodeId.slice(0, 8);
  const nodeType = ((nodeData?.type ?? node?.type) as string) || 'note';
  const Icon = NODE_ICON[nodeType as CanvasNodeType] ?? NODE_ICON.note;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectNodes([nodeId]);
    rfInstance?.fitView({
      nodes: [{ id: nodeId }],
      duration: 300,
      padding: 0.3,
    });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className="border-border hover:bg-theme-50 inline-flex cursor-pointer items-center gap-0.5 rounded border bg-white px-1 py-px align-middle text-[10px] leading-tight font-medium"
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleClick(e as unknown as React.MouseEvent);
        }
      }}
      title={`Focus: ${label}`}
    >
      <Icon size={9} className="flex-shrink-0" />
      <span className="max-w-[100px] truncate">{label}</span>
    </div>
  );
}
