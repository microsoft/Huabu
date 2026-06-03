import {
  SKETCH_COLOR_OPTIONS,
  SKETCH_SIZE_MAX,
  SKETCH_SIZE_MIN,
} from './sketchPath';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { RangeSlider } from '@/components/Common/RangeSlider';

interface SketchControlsProps {
  /** Current stroke color (accent palette token; legacy hex also accepted). */
  color: string;
  /** Current stroke thickness (perfect-freehand `size`). */
  size: number;
  /** Called with the picked palette token (see {@link SKETCH_COLOR_OPTIONS}). */
  onColorChange: (color: string) => void;
  /** Called with the new thickness (clamped to [min, max] by the slider). */
  onSizeChange: (size: number) => void;
  /**
   * Visual size for the embedded thickness slider. Defaults to `'sm'`
   * to match the compact node floating toolbar; tool settings panels
   * should pass `'md'`.
   */
  sliderSize?: 'sm' | 'md';
}

/**
 * Reusable color + thickness controls for the sketch tool.
 *
 * Used by:
 * - `SketchSettingsPanel` (pre-draw, bound to `toolStore.sketchDraft`)
 *   as the pen-mode settings row.
 * - `SketchNode`'s floating toolbar (post-draw, bound to the node's
 *   stroke data).
 *
 * Presentation-only: the parent decides where the values come from and
 * where edits go.
 */
export function SketchControls({
  color,
  size,
  onColorChange,
  onSizeChange,
  sliderSize = 'sm',
}: SketchControlsProps) {
  return (
    <>
      <FloatingToolbar.ColorPicker
        colors={SKETCH_COLOR_OPTIONS}
        value={color}
        onSelect={onColorChange}
        title="Stroke color"
      />
      <RangeSlider
        value={size}
        min={SKETCH_SIZE_MIN}
        max={SKETCH_SIZE_MAX}
        label="Stroke thickness"
        size={sliderSize}
        onChange={onSizeChange}
      />
    </>
  );
}
