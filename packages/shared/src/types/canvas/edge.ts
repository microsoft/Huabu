/**
 * Canvas Edge Types
 * Edge data structures and styling
 */

export type EdgeLineType = 'bezier' | 'straight' | 'step';
export type EdgeLineStyle = 'solid' | 'dashed' | 'dotted';

/**
 * Stroke / edge color palette shared between UI pickers and agent tool definitions.
 * Edit this list to add or remove palette entries — both the canvas toolbar
 * and the AI agent's allowed edge colours update automatically.
 */
export const STROKE_COLORS = [
  { name: 'Default', value: '#191919' },
  { name: 'Gray', value: '#9ca3af' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Purple', value: '#a855f7' },
] as const;

/** Union type of all allowed stroke hex values. */
export type StrokeColorValue = (typeof STROKE_COLORS)[number]['value'];

/** Edge stroke width presets (px). */
export const EDGE_STROKE_WIDTHS = [1, 2, 3, 4] as const;

/** Union type of all allowed stroke widths. */
export type EdgeStrokeWidth = (typeof EDGE_STROKE_WIDTHS)[number];

export interface EdgeStyle {
  lineType?: EdgeLineType;
  lineStyle?: EdgeLineStyle;
  stroke?: StrokeColorValue | (string & {});
  strokeWidth?: EdgeStrokeWidth | number;
  animated?: boolean;
}
