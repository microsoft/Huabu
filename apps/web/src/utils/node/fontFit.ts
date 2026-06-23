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
  TEXT_ACCENT_BORDER,
  TEXT_NODE_PADDING,
  TEXT_NODE_PLACEHOLDER,
} from './nodeFontConfig';
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
  /** Padding + border inset per side (content area = box − inset·2). */
  inset: number;
}

/**
 * Resolve the {@link NodeFontFit} for a node, or `null` for node types
 * that don't carry a locked `style.fontSize` (only TextNode /
 * QuestionNode do).
 */
export function getNodeFontFit(node: Node): NodeFontFit | null {
  const data = (node.data ?? {}) as {
    content?: unknown;
    input?: { kind?: string; content?: unknown };
    style?: {
      fontFamily?: string;
      fontWeight?: string;
      fontStyle?: string;
      accent?: unknown;
    };
  };
  const style = data.style ?? {};

  if (node.type === 'text') {
    return {
      text: typeof data.content === 'string' ? data.content : '',
      placeholder: TEXT_NODE_PLACEHOLDER,
      fontOpts: getTextNodeFontOpts(style),
      inset: TEXT_NODE_PADDING + (style.accent ? TEXT_ACCENT_BORDER : 0),
    };
  }

  if (node.type === 'question') {
    return {
      text: typeof data.content === 'string' ? data.content : '',
      placeholder: QUESTION_NODE_PLACEHOLDER,
      fontOpts: getQuestionFontOpts(),
      inset: QUESTION_NODE_PADDING,
    };
  }

  return null;
}

/**
 * Re-derive the largest fontSize whose text fits the node's NEW box,
 * matching the node's own resize-end behaviour. `width`/`height` are the
 * node's outer box; the content area subtracts {@link NodeFontFit.inset}.
 */
export function refitFont(
  fit: NodeFontFit,
  width: number,
  height: number,
): number {
  const contentWidth = width - fit.inset * 2;
  const contentHeight = height - fit.inset * 2;
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
