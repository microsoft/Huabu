// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolveAccent } from '@huabu/shared';

import { cn } from '@/components/Common/cn';
import { NODE_TYPE_LABEL } from '@/config/nodeIcons';
import {
  MINIMAL_LINE_HEIGHT,
  MINIMAL_MAX_LINES,
  selectTypographyTier,
} from '@/config/semanticZoom';

import { getAccentTokens } from './accentTokens';

import type { CanvasNodeType, NodeData } from './types';

interface SemanticPlaceholderProps {
  type: CanvasNodeType;
  data: NodeData;
  /** Whether minimal LOD is currently active. */
  active: boolean;
  /** Canvas-space width of the node. */
  width: number;
  /** Canvas-space height of the node. */
  height: number;
}

/** Padding (px) reserved on each side inside the placeholder. */
const PAD_X = 16;
const PAD_Y = 16;

/**
 * Lightweight placeholder rendered when a node is in 'minimal' LOD.
 *
 * The font size expresses HIERARCHY (node size), not title length: it is
 * chosen from a discrete tier scale keyed on the node's canvas dimensions
 * (see {@link selectTypographyTier}), so same-size nodes always match and the
 * zoomed-out canvas keeps a stable typographic rhythm. Because the tier font
 * is a canvas size, the label simply scales down with the node as you zoom
 * out — a smaller node always shows smaller text. Titles that don't fit wrap
 * at word boundaries (never mid-word) and then ellipsize via line-clamp; the
 * number of lines is bounded by whatever physically fits the node height, so
 * taller nodes get more lines.
 */
export function SemanticPlaceholder({
  type,
  data,
  active,
  width,
  height,
}: SemanticPlaceholderProps) {
  // Stored value is a palette token (or legacy hex); resolve to CSS color.
  const accent = resolveAccent(data.style?.accent);
  const accentTokens = accent ? getAccentTokens(accent) : null;

  const containerClassName = cn(
    'semantic-lod-placeholder pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg p-2',
    !accentTokens && 'bg-surface',
  );
  const containerStyle = accentTokens
    ? {
        background: accentTokens.bg,
        color: accentTokens.fg,
      }
    : undefined;

  const rawLabel =
    ('label' in data && typeof data.label === 'string' ? data.label : null) ||
    ('title' in data && typeof data.title === 'string' ? data.title : null) ||
    NODE_TYPE_LABEL[type] ||
    type;

  const { fontSize } = selectTypographyTier(width, height);

  // Max lines = however many physically fit the padded height, capped. Taller
  // nodes get more lines before the label ellipsizes.
  const availableHeight = Math.max(0, height - PAD_Y * 2);
  const maxLines = Math.max(
    1,
    Math.min(
      MINIMAL_MAX_LINES,
      Math.floor(availableHeight / (fontSize * MINIMAL_LINE_HEIGHT)),
    ),
  );

  return (
    <div
      className={containerClassName}
      style={containerStyle}
      data-lod={active ? 'minimal' : 'full'}
      aria-hidden={!active}
    >
      {/*
        `overflow-wrap: break-word` wraps at word boundaries first and only
        splits *inside* a token when that token alone is wider than the box —
        which prevents a long unbreakable string (e.g. "arXiv:1409.3215") from
        overflowing the frame and being clipped mid-character. Normal words are
        never broken. `-webkit-box` + `-webkit-line-clamp` clamps to `maxLines`
        and appends an ellipsis on overflow; the font size is NOT reduced to
        fit, keeping the tier-based rhythm intact.
      */}
      <span
        className="block w-full text-center font-medium"
        style={{
          fontSize: `${fontSize}px`,
          lineHeight: MINIMAL_LINE_HEIGHT,
          paddingLeft: PAD_X - 8,
          paddingRight: PAD_X - 8,
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: maxLines,
          overflow: 'hidden',
          wordBreak: 'normal',
          overflowWrap: 'break-word',
        }}
      >
        {rawLabel}
      </span>
    </div>
  );
}
