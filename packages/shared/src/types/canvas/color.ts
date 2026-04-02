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
  { name: 'Default', value: '#191919' },
  { name: 'Gray', value: '#9ca3af' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#D97A2B' },
  { name: 'Amber', value: '#F2D479' },
  { name: 'Green', value: '#6FAF4F' },
  { name: 'Blue', value: '#4E8D9C' },
  { name: 'Purple', value: '#9B8EC7' },
] as const;

/** Union type of all allowed palette hex values. */
export type PaletteColorValue = (typeof COLOR_PALETTE)[number]['value'];

// Backward-compatible aliases
/** @deprecated Use COLOR_PALETTE instead */
export const STROKE_COLORS = COLOR_PALETTE;
/** @deprecated Use PaletteColorValue instead */
export type StrokeColorValue = PaletteColorValue;

/** Node background color presets (Tailwind classes). */
export const NODE_BG_COLORS = [
  { name: 'Transparent', value: 'bg-transparent' },
  { name: 'White', value: 'bg-white' },
  { name: 'Red', value: 'bg-red-50' },
  { name: 'Orange', value: 'bg-orange-50' },
  { name: 'Yellow', value: 'bg-yellow-50' },
  { name: 'Green', value: 'bg-green-50' },
  { name: 'Blue', value: 'bg-blue-50' },
  { name: 'Purple', value: 'bg-purple-50' },
] as const;

/** Union type of all allowed node background color values. */
export type NodeBgColorValue = (typeof NODE_BG_COLORS)[number]['value'];
