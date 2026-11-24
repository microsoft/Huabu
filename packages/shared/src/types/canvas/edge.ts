// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas Edge Types
 * Edge data structures and styling
 */

import type { AccentToken } from './color.js';
import type { LabelSource } from './node.js';

/**
 * Allowed line shapes for edges. The `as const` array is the single source
 * of truth — both the TypeScript union and the agent-facing TypeBox schema
 * are derived from it, so adding a value here automatically propagates.
 */
export const EDGE_LINE_TYPES = ['bezier', 'straight', 'step'] as const;
export type EdgeLineType = (typeof EDGE_LINE_TYPES)[number];

/** Allowed dash patterns. Source of truth for both TS union and schema. */
export const EDGE_LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export type EdgeLineStyle = (typeof EDGE_LINE_STYLES)[number];

/** Allowed arrow directions. Source of truth for both TS union and schema. */
export const EDGE_DIRECTIONS = ['none', 'forward', 'backward', 'both'] as const;
export type EdgeDirection = (typeof EDGE_DIRECTIONS)[number];

/** Edge stroke width presets (px). */
export const EDGE_STROKE_WIDTHS = [2, 4, 8, 16] as const;

/** Maximum inverse-zoom scale used by edge labels and gutter planning. */
export const EDGE_LABEL_MAX_INVERSE_SCALE = 2.5;

/** Union type of all allowed stroke widths. */
export type EdgeStrokeWidth = (typeof EDGE_STROKE_WIDTHS)[number];

export interface EdgeStyle {
  lineType?: EdgeLineType;
  lineStyle?: EdgeLineStyle;
  /**
   * Palette token (preferred — e.g. `'purple'`) or a literal CSS color
   * string for legacy data / one-off custom colors. Resolved via
   * `resolveAccent` at render time.
   */
  stroke?: AccentToken | (string & {});
  strokeWidth?: EdgeStrokeWidth | number;
  direction?: EdgeDirection;
  label?: string;
  labelSource?: LabelSource;
}
