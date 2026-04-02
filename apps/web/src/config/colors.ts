import {
  COLOR_PALETTE as _COLOR_PALETTE,
  EDGE_STROKE_WIDTHS as _EDGE_STROKE_WIDTHS,
} from '@sediment/shared';
// Source of truth: packages/shared/src/types/canvas/edge.ts

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

export const NODE_BG_COLORS: ColorPreset[] = [
  {
    name: 'Transparent',
    value: 'bg-transparent',
    border: 'border-info',
    ring: 'ring-transparent',
  },
  {
    name: 'White',
    value: 'bg-white',
    border: 'border-edge-default',
    ring: 'ring-gray-200',
  },
  {
    name: 'Red',
    value: 'bg-red-50',
    border: 'border-red-200',
    ring: 'ring-red-200',
  },
  {
    name: 'Orange',
    value: 'bg-orange-50',
    border: 'border-orange-200',
    ring: 'ring-orange-200',
  },
  {
    name: 'Yellow',
    value: 'bg-yellow-50',
    border: 'border-yellow-200',
    ring: 'ring-yellow-200',
  },
  {
    name: 'Green',
    value: 'bg-green-50',
    border: 'border-green-200',
    ring: 'ring-green-200',
  },
  {
    name: 'Blue',
    value: 'bg-blue-50',
    border: 'border-blue-200',
    ring: 'ring-blue-200',
  },
  {
    name: 'Purple',
    value: 'bg-purple-50',
    border: 'border-purple-200',
    ring: 'ring-purple-200',
  },
];

// ---- Shared hex-based color palette ----
// Used by edge strokes, text colors, and node accents so the palette
// stays visually consistent across all elements.
// Source of truth lives in @sediment/shared; re-exported here with
// the ColorPreset type expected by UI components.

export const COLOR_PALETTE: ColorPreset[] = [..._COLOR_PALETTE];

/** @deprecated Use COLOR_PALETTE instead */
export const STROKE_COLORS = COLOR_PALETTE;

// ---- Edge stroke width presets (px) ----

export const EDGE_STROKE_WIDTHS = [..._EDGE_STROKE_WIDTHS];
