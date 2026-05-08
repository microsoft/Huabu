import { resolveAccent } from '@sediment/shared';

import { cn } from '@/components/Common/cn';
import { NODE_TYPE_LABEL } from '@/config/nodeIcons';
import { useClusterFontSize } from '@/hooks/useClusterFontSize';

import { getAccentTokens } from './accentTokens';

import type { CanvasNodeType, NodeData } from './types';

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
  /** ReactFlow node ID — used for cluster-based font size normalisation. */
  nodeId: string;
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
  nodeId,
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

  // Stored value is a palette token (or legacy hex); resolve to CSS color.
  const accent = resolveAccent(data.style?.accent);
  const accentTokens = accent ? getAccentTokens(accent) : null;

  const fontSize = useClusterFontSize(nodeId, label, width, height);

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded p-2 transition-all duration-120',
        !accentTokens && 'bg-surface shadow',
        accentTokens && 'border-4',
      )}
      style={
        accentTokens
          ? {
              borderColor: accentTokens.border,
              background: accentTokens.bg,
              color: accentTokens.fg,
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
