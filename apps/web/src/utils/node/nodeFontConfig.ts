// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Single source of truth for text-bearing node font configuration.
 *
 * `TextNode` and `QuestionNode` render text whose size is auto-fitted to
 * the node box (via `useTextNodeSurface` / `computeFontSizeForHeight`).
 * The frame-resize cascade ({@link ./fontFit}) re-derives that same font
 * for a node's new box. Both paths MUST agree on the font family stacks,
 * paddings and line-height — so they all live here and are imported,
 * never re-declared.
 */

import type { FontOpts } from './textMeasure';
import type { NodeFontFamily } from '@huabu/shared';

/** Map logical font family names to CSS font stacks. */
export const FONT_FAMILY_CSS: Record<NodeFontFamily, string> = {
  default: 'ui-sans-serif, system-ui, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  hand: '"Comic Sans MS", "Chalkboard SE", sans-serif',
};

/** Horizontal padding inside a TextNode (px on the left and right). */
export const TEXT_NODE_PADDING_X = 12;
/** Vertical padding inside a TextNode (px on the top and bottom). */
export const TEXT_NODE_PADDING_Y = 4;

/** Padding inside a QuestionNode (px on each side). */
export const QUESTION_NODE_PADDING = 12;
/** Font family for the question sticky-note style. */
export const QUESTION_FONT_FAMILY =
  '"Comic Sans MS", STXingkai, KaiTi, "Kaiti SC", cursive';

/**
 * Placeholder text shown (and measured for auto-sizing) when a node has
 * no content yet. Both the node component and the frame-resize cascade
 * ({@link ./fontFit}) measure these strings when the content is empty, so
 * an empty node is sized to fit its placeholder rather than to fill its
 * whole height with a single oversized line.
 */
export const TEXT_NODE_PLACEHOLDER = 'Type...';
export const QUESTION_NODE_PLACEHOLDER = 'Ask a question…';

/** Line-height used by every text-bearing node's measurement. */
export const NODE_LINE_HEIGHT = 1.5;

/** Style fields that influence a TextNode's measured font. */
export interface TextNodeFontStyle {
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
}

/** Build the pretext {@link FontOpts} for a TextNode from its style. */
export function getTextNodeFontOpts(style: TextNodeFontStyle): FontOpts {
  return {
    fontFamily:
      FONT_FAMILY_CSS[(style.fontFamily ?? 'default') as NodeFontFamily] ??
      FONT_FAMILY_CSS.default,
    fontWeight: style.fontWeight === 'bold' ? 'bold' : 'normal',
    fontStyle: style.fontStyle === 'italic' ? 'italic' : 'normal',
    lineHeight: NODE_LINE_HEIGHT,
  };
}

/** Build the pretext {@link FontOpts} for a QuestionNode (fixed style). */
export function getQuestionFontOpts(): FontOpts {
  return {
    fontFamily: QUESTION_FONT_FAMILY,
    fontWeight: 'normal',
    fontStyle: 'normal',
    lineHeight: NODE_LINE_HEIGHT,
  };
}
