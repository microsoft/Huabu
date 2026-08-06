// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Frame-resize font fitting.
 *
 * When a frame is resized, its text-bearing children (TextNode /
 * QuestionNode) are scaled with it. A pure geometric `fontSize *
 * min(sx, sy)` multiplier handles text poorly: it ignores re-wrapping,
 * so widening a node (large `sx`) while keeping its height (small `sy`)
 * caps the font to the smaller axis even though the text could now grow.
 *
 * Instead we re-derive each child's font with the SAME content-aware
 * pretext fit the node uses for its own resize
 * ({@link computeFontSizeForHeight} via `useTextAutoSize`), so a
 * cascaded resize and a direct resize land on the same fontSize.
 *
 * Font families / paddings / line-height come from the shared
 * {@link ./nodeFontConfig} module — the same constants the node
 * components render with — so there is nothing to keep in sync here.
 */

import {
  getQuestionFontOpts,
  getTextNodeFontOpts,
  QUESTION_NODE_PADDING,
  QUESTION_NODE_PLACEHOLDER,
  TEXT_NODE_PADDING_X,
  TEXT_NODE_PADDING_Y,
  TEXT_NODE_PLACEHOLDER,
} from './nodeFontConfig';
import { getQuestionDisplayText } from './questionDisplayText';
import { computeFontSizeForHeight, type FontOpts } from './textMeasure';

import type { Node } from '@xyflow/react';

/**
 * Everything {@link refitFont} needs to re-derive a node's locked
 * fontSize for a new box, captured once at gesture start.
 */
export interface NodeFontFit {
  /** The node's text content at gesture start (drives wrapping). */
  text: string;
  /**
   * Placeholder shown when {@link text} is empty. Measured in place of an
   * empty string so an empty node refits to fit its placeholder — matching
   * `useTextAutoSize`'s own resize path — instead of collapsing to a single
   * giant line that overflows the box.
   */
  placeholder: string;
  /** Pretext font options matching the node's own measurement path. */
  fontOpts: FontOpts;
  /**
   * Horizontal inset per side — the body's padding, and nothing else.
   * The node shell's border is deliberately excluded, exactly as in
   * `useTextAutoSize`: the body is sized to the node's outer width, so
   * the text lays out at `width - 2 * paddingX` regardless of the border.
   */
  insetX: number;
  /** Vertical inset per side. Same rule as {@link NodeFontFit.insetX}. */
  insetY: number;
}

/**
 * Resolve the {@link NodeFontFit} for a node, or `null` for node types
 * that don't carry a locked `style.fontSize` (only TextNode /
 * QuestionNode do).
 */
export function getNodeFontFit(node: Node): NodeFontFit | null {
  const data = (node.data ?? {}) as {
    content?: unknown;
    label?: unknown;
    input?: { kind?: string; content?: unknown };
    style?: {
      fontFamily?: string;
      fontWeight?: string;
      fontStyle?: string;
    };
  };
  const style = data.style ?? {};

  if (node.type === 'text') {
    return {
      text: typeof data.content === 'string' ? data.content : '',
      placeholder: TEXT_NODE_PLACEHOLDER,
      fontOpts: getTextNodeFontOpts(style),
      insetX: TEXT_NODE_PADDING_X,
      insetY: TEXT_NODE_PADDING_Y,
    };
  }

  if (node.type === 'question') {
    return {
      text: getQuestionDisplayText(data),
      placeholder: QUESTION_NODE_PLACEHOLDER,
      fontOpts: getQuestionFontOpts(),
      insetX: QUESTION_NODE_PADDING,
      insetY: QUESTION_NODE_PADDING,
    };
  }

  return null;
}

/**
 * Re-derive the largest fontSize whose text fits the node's NEW box,
 * matching the node's own resize-end behaviour. `width`/`height` are the
 * node's outer box; the content area subtracts the axis-specific insets.
 */
export function refitFont(
  fit: NodeFontFit,
  width: number,
  height: number,
): number {
  const contentWidth = width - fit.insetX * 2;
  const contentHeight = height - fit.insetY * 2;
  // Mirror `useTextAutoSize`: when empty, size the placeholder so the
  // cascaded font matches what a direct resize of the empty node lands on.
  const measureText = fit.text.trim() ? fit.text : fit.placeholder;
  return computeFontSizeForHeight(
    measureText,
    contentWidth,
    contentHeight,
    fit.fontOpts,
  );
}
