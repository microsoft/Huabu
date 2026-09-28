// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Single source of truth for text-bearing node font configuration.
 *
 * TextNode and QuestionNode use proportional `data.style.fontSize` through
 * useTextNodeSurface: defaults are 16px and QUESTION_NODE_DEFAULT_FONT_SIZE.
 * Question chrome retains its 28px artwork basis independently of the default. Side grips
 * preserve the font; corners and the Hug Frame/selection cascade ({@link ./fontFit})
 * scale it by the new/start outer-width ratio without fitting or rounding.
 * Existing fonts are respected without automatic persisted-data migration.
 * Measurement and rendering MUST agree on the font family stacks,
 * paddings and line-height — so they all live here and are imported,
 * never re-declared.
 */

import { NODE_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';

import type { FontOpts } from './textMeasure';
import type { NodeFontFamily } from '@huabu/shared';

/** Map logical font family names to CSS font stacks. */
export const FONT_FAMILY_CSS: Record<NodeFontFamily, string> = {
  default: 'ui-sans-serif, system-ui, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  hand: '"Comic Sans MS", "Chalkboard SE", sans-serif',
};

/** Base horizontal TextNode padding (px per side), scaled by fontSize / 16. */
export const TEXT_NODE_PADDING_X = 8;
/** Base vertical TextNode padding (px per side), scaled by fontSize / 16. */
export const TEXT_NODE_PADDING_Y = 3;

export const QUESTION_NODE_DEFAULT_FONT_SIZE = 24;

/** Symmetric horizontal inset shared by measurement and the C card. */
export const QUESTION_NODE_PADDING = 24;
export const QUESTION_NODE_PADDING_Y = QUESTION_NODE_PADDING;
/** The avatar sets the row height; the status chip uses shared metadata type. */
export const QUESTION_NODE_HEADER_HEIGHT = 32;
export const QUESTION_NODE_STATUS_SIZE = NODE_TYPOGRAPHY.metadata.size;
export const QUESTION_NODE_HEADER_GAP = 12;
/** Half the base metadata-row-plus-gap height; scales with Question content. */
export const QUESTION_NODE_HEADER_INSET =
  (QUESTION_NODE_HEADER_HEIGHT + QUESTION_NODE_HEADER_GAP) / 2;
/** Font family for the compact conversation card and its text measurement. */
export const QUESTION_FONT_FAMILY = FONT_FAMILY_CSS.default;
/** Medium weight shared by Question rendering and text measurement. */
export const QUESTION_NODE_TITLE_WEIGHT = 500;

/**
 * Placeholder text shown (and measured for auto-sizing) when a node has
 * no content yet. useTextAutoSize measures these strings at the effective
 * font size; Frame/selection scaling preserves that font/width ratio without
 * measuring or fitting the placeholder to a dragged height.
 */
export const TEXT_NODE_PLACEHOLDER = 'Type...';
export const QUESTION_NODE_PLACEHOLDER = 'Ask a question…';

/** Unitless line-height used by TextNode measurement; Question uses cardTitle. */
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

/** Question measurement family, weight and line-height; font size is proportional. */
export function getQuestionFontOpts(): FontOpts {
  return {
    fontFamily: QUESTION_FONT_FAMILY,
    fontWeight: String(QUESTION_NODE_TITLE_WEIGHT),
    fontStyle: 'normal',
    lineHeight: NODE_TYPOGRAPHY.cardTitle.lineHeight,
  };
}
