/**
 * Canvas Edge Types
 * Edge data structures and styling
 */

import type { AccentToken } from './color.js';

export type EdgeLineType = 'bezier' | 'straight' | 'step';
export type EdgeLineStyle = 'solid' | 'dashed' | 'dotted';
export type EdgeDirection = 'none' | 'forward' | 'backward' | 'both';

/** Edge stroke width presets (px). */
export const EDGE_STROKE_WIDTHS = [2, 4, 8, 16] as const;

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
  animated?: boolean;
  direction?: EdgeDirection;
}
