/**
 * Centralized node type → icon mapping.
 *
 * Single source of truth for every icon associated with a CanvasNodeType.
 * When you need to change an icon for a node type, update it HERE and
 * every usage across the app will pick up the change automatically.
 */

import {
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  SquareDashed,
  ClipboardPen,
  Type,
} from 'lucide-react';

import type { CanvasNodeType } from '@sediment/shared';
import type { LucideIcon } from 'lucide-react';

/**
 * Maps each CanvasNodeType to its canonical Lucide icon component.
 *
 * Usage:
 * ```tsx
 * import { NODE_ICON } from '@/config/nodeIcons';
 * const Icon = NODE_ICON.note;
 * <Icon size={14} />
 * ```<ClipboardPen />
 */
export const NODE_ICON: Record<CanvasNodeType, LucideIcon> = {
  note: ClipboardPen,
  text: Type,
  image: ImageIcon,
  pdf: FileText,
  video: Film,
  web: Globe,
  frame: SquareDashed,
};

/**
 * Human-readable display name for each node type.
 */
export const NODE_TYPE_LABEL: Record<CanvasNodeType, string> = {
  note: 'Note',
  text: 'Text',
  image: 'Image',
  pdf: 'PDF',
  video: 'Video',
  web: 'Website',
  frame: 'Frame',
};

/**
 * Returns the icon component for a given node type string.
 * Falls back to the frame icon for unknown types.
 */
export function getNodeIcon(type: string | undefined): LucideIcon {
  if (type && type in NODE_ICON) {
    return NODE_ICON[type as CanvasNodeType];
  }
  return NODE_ICON.frame;
}
