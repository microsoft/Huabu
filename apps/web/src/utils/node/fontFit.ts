// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Proportional Text/Question content scaling for Frame and selection resize. */

import { getNodeSize } from '@huabu/shared/canvas-engine';

import { QUESTION_NODE_DEFAULT_FONT_SIZE } from './nodeFontConfig';

import type { Node } from '@xyflow/react';

/**
 * Immutable gesture-start values for proportional scaling. The legacy name
 * is retained for callers; no content measurement or best-fit search occurs.
 */
export interface NodeFontFit {
  /** Effective persisted font, or the node type's finite positive default. */
  fontSize: number;
  /** Outer width from the canonical size reader, before any preview writes. */
  width: number;
}

/**
 * Capture Text/Question content scale. Question's font controls its full card,
 * not only the title. Other types, including Note, retain their own policies.
 */
export function getNodeFontFit(node: Node): NodeFontFit | null {
  if (node.type !== 'text' && node.type !== 'question') return null;
  const data = (node.data ?? {}) as {
    style?: { fontSize?: unknown };
  };
  const fontSize = data.style?.fontSize;
  return {
    fontSize:
      typeof fontSize === 'number' && Number.isFinite(fontSize) && fontSize > 0
        ? fontSize
        : node.type === 'question'
          ? QUESTION_NODE_DEFAULT_FONT_SIZE
          : 16,
    width: getNodeSize(node).width,
  };
}

/**
 * Scale the starting font by the new/start outer-width ratio, without rounding
 * or re-fitting. Height is accepted for call-site compatibility but does not
 * affect content scale. Missing/invalid geometry preserves the starting font.
 */
export function refitFont(
  fit: NodeFontFit,
  width: number,
  _height: number,
): number {
  if (
    !Number.isFinite(fit.width) ||
    fit.width <= 0 ||
    !Number.isFinite(width) ||
    width <= 0
  ) {
    return fit.fontSize;
  }
  const scaled = (fit.fontSize * width) / fit.width;
  return Number.isFinite(scaled) && scaled > 0 ? scaled : fit.fontSize;
}
