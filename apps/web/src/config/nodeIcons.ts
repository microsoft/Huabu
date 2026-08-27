// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Centralized node type → icon mapping.
 *
 * Single source of truth for every icon associated with a CanvasNodeType.
 * When you need to change an icon for a node type, update it HERE and
 * every usage across the app will pick up the change automatically.
 */

import {
  BookOpen,
  Film,
  FileType2,
  FileText,
  Globe,
  Image as ImageIcon,
  Frame,
  Clipboard,
  Presentation,
  Sheet,
  Type,
  Pencil,
  Mic,
  MessageCircleQuestionMark,
  PanelsTopLeft,
  Pin,
} from 'lucide-react';

import type { CanvasNodeType, OfficeFormat } from '@huabu/shared';
import type { LucideIcon } from 'lucide-react';

/**
 * Maps each CanvasNodeType to its canonical Lucide icon component.
 *
 * Usage:
 * ```tsx
 * import { NODE_ICON } from '@/config/nodeIcons';
 * const Icon = NODE_ICON.note;
 * <Icon size={14} />
 * ```
 */
export const NODE_ICON: Record<CanvasNodeType, LucideIcon> = {
  note: Clipboard,
  text: Type,
  image: ImageIcon,
  pdf: BookOpen,
  // Generic Office icon — used by surfaces that don't have a specific
  // node instance in hand (filter bars, type pickers, fallbacks).
  // For per-instance rendering prefer `getNodeIcon(type, data)` so
  // the format-specific Word / Excel / PowerPoint icon (see
  // {@link OFFICE_FORMAT_ICON}) is returned instead — that keeps the
  // sidebar / breadcrumb in lock-step with what `OfficeNode` paints
  // on the canvas card.
  office: FileType2,
  video: Film,
  audio: Mic,
  web: Globe,
  frame: Frame,
  spacePreview: PanelsTopLeft,
  canvasRef: PanelsTopLeft,
  frameRef: Frame,
  nodeRef: Pin,
  sketch: Pencil,
  question: MessageCircleQuestionMark,
};

/**
 * Per-format Office icon map.
 *
 * Kept here (rather than inside `OfficeNode`) so every surface that
 * renders an office node — the canvas card, the layer panel sidebar,
 * the expanded preview breadcrumb — resolves to the same icon. Without
 * this central map the sidebar fell back to the generic {@link NODE_ICON.office}
 * while the canvas card painted Word / Excel / PowerPoint, leaving the
 * two surfaces visibly out of sync.
 */
export const OFFICE_FORMAT_ICON: Record<OfficeFormat, LucideIcon> = {
  docx: FileText,
  xlsx: Sheet,
  pptx: Presentation,
};

/**
 * Human-readable display name for each node type.
 */
export const NODE_TYPE_LABEL: Record<CanvasNodeType, string> = {
  note: 'Note',
  text: 'Text',
  image: 'Image',
  pdf: 'PDF',
  office: 'Office',
  video: 'Video',
  audio: 'Audio',
  web: 'Website',
  frame: 'Frame',
  spacePreview: 'Space Preview',
  canvasRef: 'Portal',
  frameRef: 'Pinned frame',
  nodeRef: 'Pinned reference',
  sketch: 'Sketch',
  question: 'Agent Node',
};

/**
 * Returns the icon component for a given node type string.
 *
 * Pass `data` whenever a specific node instance is in hand — it lets
 * the resolver return a sub-type icon (currently: office.format →
 * Word / Excel / PowerPoint) so list / sidebar / breadcrumb renderings
 * stay aligned with what the on-canvas node card paints. Without
 * `data` the function returns the generic per-type icon, which is the
 * right behavior for filter bars and type pickers.
 *
 * Falls back to the frame icon for unknown types.
 */
export function getNodeIcon(
  type: string | undefined,
  data?: Record<string, unknown>,
): LucideIcon {
  if (type === 'office') {
    const format = data?.['format'];
    if (typeof format === 'string' && format in OFFICE_FORMAT_ICON) {
      return OFFICE_FORMAT_ICON[format as OfficeFormat];
    }
    return NODE_ICON.office;
  }
  if (type && type in NODE_ICON) {
    return NODE_ICON[type as CanvasNodeType];
  }
  return NODE_ICON.frame;
}
