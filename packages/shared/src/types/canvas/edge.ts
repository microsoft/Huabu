/**
 * Canvas Edge Types
 * Edge data structures and styling
 */

export type { PaletteColorValue, StrokeColorValue } from './color.js';
export { COLOR_PALETTE, STROKE_COLORS } from './color.js';

import type { PaletteColorValue } from './color.js';

export type EdgeLineType = 'bezier' | 'straight' | 'step';
export type EdgeLineStyle = 'solid' | 'dashed' | 'dotted';
export type EdgeDirection = 'none' | 'forward' | 'backward' | 'both';

/** Edge stroke width presets (px). */
export const EDGE_STROKE_WIDTHS = [1, 2, 3, 4] as const;

/** Union type of all allowed stroke widths. */
export type EdgeStrokeWidth = (typeof EDGE_STROKE_WIDTHS)[number];

export interface EdgeStyle {
  lineType?: EdgeLineType;
  lineStyle?: EdgeLineStyle;
  stroke?: PaletteColorValue | (string & {});
  strokeWidth?: EdgeStrokeWidth | number;
  animated?: boolean;
  direction?: EdgeDirection;
}
