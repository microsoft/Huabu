import {
  COLOR_PALETTE as _COLOR_PALETTE,
  EDGE_STROKE_WIDTHS as _EDGE_STROKE_WIDTHS,
  NODE_BG_COLORS as _NODE_BG_COLORS,
} from '@sediment/shared';
// Source of truth: packages/shared/src/types/canvas/color.ts

import type { ColorPreset } from '@/components/Common/ColorPicker';

/**
 * Centralized color preset definitions used across node backgrounds,
 * text colors, and edge strokes.  Edit this file to add/remove palette
 * entries — all related UI pickers will update automatically.
 *
 * Stroke colors and edge widths are defined in @sediment/shared so that
 * the server-side agent tool definitions stay in sync automatically.
 */

// ---- Node background colors (Tailwind class-based) ----
// Derived from @sediment/shared; UI-specific border/ring classes added here.

const NODE_BG_STYLE: Record<string, { border: string; ring: string }> = {
  'bg-transparent': { border: 'border-info', ring: 'ring-transparent' },
  'bg-white': { border: 'border-edge-default', ring: 'ring-gray-200' },
  'bg-red-50': { border: 'border-red-200', ring: 'ring-red-200' },
  'bg-orange-50': { border: 'border-orange-200', ring: 'ring-orange-200' },
  'bg-yellow-50': { border: 'border-yellow-200', ring: 'ring-yellow-200' },
  'bg-green-50': { border: 'border-green-200', ring: 'ring-green-200' },
  'bg-blue-50': { border: 'border-blue-200', ring: 'ring-blue-200' },
  'bg-purple-50': { border: 'border-purple-200', ring: 'ring-purple-200' },
};

export const NODE_BG_COLORS: ColorPreset[] = _NODE_BG_COLORS.map((c) => ({
  ...c,
  ...NODE_BG_STYLE[c.value],
}));

// ---- Shared hex-based color palette ----
// Used by edge strokes, text colors, and node accents so the palette
// stays visually consistent across all elements.
// Source of truth lives in @sediment/shared; re-exported here with
// the ColorPreset type expected by UI components.

export const COLOR_PALETTE: ColorPreset[] = [..._COLOR_PALETTE];

// ---- Edge stroke width presets (px) ----

export const EDGE_STROKE_WIDTHS = [..._EDGE_STROKE_WIDTHS];
