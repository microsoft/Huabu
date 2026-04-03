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

// ---- Node background colors (hex / CSS keyword) ----
// Derived from @sediment/shared.

export const NODE_BG_COLORS: ColorPreset[] = [..._NODE_BG_COLORS];

// ---- Shared hex-based color palette ----
// Used by edge strokes, text colors, and node accents so the palette
// stays visually consistent across all elements.
// Source of truth lives in @sediment/shared; re-exported here with
// the ColorPreset type expected by UI components.

export const COLOR_PALETTE: ColorPreset[] = [..._COLOR_PALETTE];

// ---- Edge stroke width presets (px) ----

export const EDGE_STROKE_WIDTHS = [..._EDGE_STROKE_WIDTHS];
