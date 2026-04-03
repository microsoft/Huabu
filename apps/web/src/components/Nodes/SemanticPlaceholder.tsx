import { cn } from '@/components/Common/cn';
import { NODE_TYPE_LABEL } from '@/config/nodeIcons';
import { useFitText } from '@/hooks/useFitText';

import type { CanvasNodeType, NodeData } from './types';

/** Padding (px) reserved on each side inside the placeholder. */
const PADDING_X = 48;
const PADDING_Y = 16;

const ZWS = '\u200B';

/** Insert zero-width spaces at camelCase / digit-letter boundaries so
 *  line-breaking prefers natural word segments over arbitrary splits. */
function insertSoftBreaks(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, `$1${ZWS}$2`)
    .replace(/(\d)([A-Za-z])/g, `$1${ZWS}$2`)
    .replace(/([A-Za-z])(\d)/g, `$1${ZWS}$2`);
}

interface SemanticPlaceholderProps {
  type: CanvasNodeType;
  data: NodeData;
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
  width,
  height,
}: SemanticPlaceholderProps) {
  const rawLabel =
    ('label' in data && typeof data.label === 'string' ? data.label : null) ||
    ('title' in data && typeof data.title === 'string' ? data.title : null) ||
    NODE_TYPE_LABEL[type] ||
    type;

  const label = insertSoftBreaks(rawLabel);

  const accent = data.style?.accent;

  const fontSize = useFitText(
    label,
    Math.max(0, width - PADDING_X * 2),
    Math.max(0, height - PADDING_Y * 2),
  );

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded p-2 transition-all duration-120',
        !accent && 'bg-surface shadow',
        accent && 'border-6',
      )}
      style={
        accent
          ? {
              borderColor: `${accent}80`,
              background: `color-mix(in srgb, ${accent} 10%, var(--bg-surface))`,
              color: `color-mix(in srgb, ${accent} 60%, var(--fg-default))`,
            }
          : undefined
      }
    >
      <span
        className="inline-flex items-center text-center leading-snug font-medium text-balance [word-break:break-word]"
        style={{ fontSize: `${fontSize}px` }}
      >
        <span>{label}</span>
      </span>
    </div>
  );
}
