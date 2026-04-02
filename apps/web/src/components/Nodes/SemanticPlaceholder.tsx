import { cn } from '@/components/Common/cn';
import { NODE_TYPE_LABEL } from '@/config/nodeIcons';
import { useFitText } from '@/hooks/useFitText';

import type { CanvasNodeType, NodeData } from './types';

/** Padding (px) reserved on each side inside the placeholder. */
const PADDING = 16;

interface SemanticPlaceholderProps {
  type: CanvasNodeType;
  data: NodeData;
  selected?: boolean;
  /** Canvas-space width of the node. */
  width: number;
  /** Canvas-space height of the node. */
  height: number;
}

/**
 * Lightweight placeholder rendered when a node is in 'minimal' LOD.
 * Shows a type icon + label with a font size dynamically computed
 * (via pretext) to fill the available space.
 */
export function SemanticPlaceholder({
  type,
  data,
  selected,
  width,
  height,
}: SemanticPlaceholderProps) {
  const label =
    ('label' in data && typeof data.label === 'string' ? data.label : null) ||
    ('title' in data && typeof data.title === 'string' ? data.title : null) ||
    NODE_TYPE_LABEL[type] ||
    type;

  const fontSize = useFitText(
    label,
    Math.max(0, width - PADDING * 2),
    Math.max(0, height - PADDING * 2),
  );
  return (
    <div
      className={cn(
        'bg-surface absolute inset-0 z-20 flex items-center justify-center rounded p-2 transition-all duration-120',
        'shadow',
        selected ? 'ring-info ring' : 'ring-border hover:ring',
      )}
    >
      <span
        className="text-fg-default inline-flex items-center gap-1.5 text-center leading-snug font-medium break-words"
        style={{ fontSize: `${fontSize}px` }}
      >
        <span>{label}</span>
      </span>
    </div>
  );
}
