/**
 * Canvas Color Types
 * Shared color palettes and background color presets
 */

/**
 * Shared color palette used by edge strokes, text colors, and node accents.
 * Edit this list to add or remove palette entries — all canvas toolbars
 * and the AI agent's allowed colours update automatically.
 */
export const COLOR_PALETTE = [
  { name: 'Default', value: '#A8A29E' },
  { name: 'Red', value: '#D07C74' },
  { name: 'Orange', value: '#D89A5B' },
  { name: 'Amber', value: '#F2D479' },
  { name: 'Green', value: '#7FB38A' },
  { name: 'Blue', value: '#5F8F9B' },
  { name: 'Purple', value: '#A08FC0' },
] as const;

/** Union type of all allowed palette hex values. */
export type PaletteColorValue = (typeof COLOR_PALETTE)[number]['value'];

// Backward-compatible aliases
/** @deprecated Use COLOR_PALETTE instead */
export const STROKE_COLORS = COLOR_PALETTE;
/** @deprecated Use PaletteColorValue instead */
export type StrokeColorValue = PaletteColorValue;

/** Node background color presets (hex / CSS keyword). */
export const NODE_BG_COLORS = [
  { name: 'Transparent', value: 'transparent' },
  { name: 'White', value: '#ffffff' },
  { name: 'Red', value: '#fef2f2' },
  { name: 'Orange', value: '#fff7ed' },
  { name: 'Yellow', value: '#fefce8' },
  { name: 'Green', value: '#f0fdf4' },
  { name: 'Blue', value: '#eff6ff' },
  { name: 'Purple', value: '#faf5ff' },
] as const;

/** Union type of all allowed node background color values. */
export type NodeBgColorValue = (typeof NODE_BG_COLORS)[number]['value'];
