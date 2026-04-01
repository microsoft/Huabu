import { cn } from '@/components/Common/cn';
import { getNodeIcon, NODE_TYPE_LABEL } from '@/config/nodeIcons';

import type { CanvasNodeType, NodeData } from './types';

interface SemanticPlaceholderProps {
  type: CanvasNodeType;
  data: NodeData;
  selected?: boolean;
}

/**
 * Lightweight placeholder rendered when a node is in 'minimal' LOD.
 * Shows a type icon + label, preserving the same dimensions as the real node.
 */
export function SemanticPlaceholder({
  type,
  data,
  selected,
}: SemanticPlaceholderProps) {
  const Icon = getNodeIcon(type);
  const label =
    ('label' in data && typeof data.label === 'string' ? data.label : null) ||
    ('title' in data && typeof data.title === 'string' ? data.title : null) ||
    NODE_TYPE_LABEL[type] ||
    type;

  return (
    <div
      className={cn(
        'bg-surface absolute inset-0 z-20 flex items-center justify-center rounded p-2 transition-all duration-120',
        'shadow',
        selected ? 'ring-info ring' : 'ring-border hover:ring',
      )}
    >
      <span className="text-fg-default inline-flex items-center gap-1.5 text-center text-sm leading-snug font-medium break-words">
        <Icon size={16} className="text-fg-muted inline shrink-0" />
        <span className="line-clamp-3">{label}</span>
      </span>
    </div>
  );
}
