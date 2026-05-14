import { FloatingToolbar } from '@/components/Common/FloatingToolbar';

import {
  SKETCH_COLOR_OPTIONS,
  SKETCH_SIZE_MAX,
  SKETCH_SIZE_MIN,
} from './sketchPath';

interface SketchControlsProps {
  /** Current stroke color (accent palette token; legacy hex also accepted). */
  color: string;
  /** Current stroke thickness (perfect-freehand `size`). */
  size: number;
  /** Called with the picked palette token (see {@link SKETCH_COLOR_OPTIONS}). */
  onColorChange: (color: string) => void;
  /** Called with the new thickness (clamped to [min, max] by the slider). */
  onSizeChange: (size: number) => void;
}

/**
 * Reusable color + thickness controls for the sketch tool.
 *
 * Used in two places:
 * 1. Pre-draw — mounted by `Canvas.tsx` while the sketch tool is the
 *    pending node type; bound to `canvasStore.sketchDraft`.
 * 2. Post-draw — embedded in `SketchNode`'s floating toolbar; bound to
 *    that node's `data.strokeColor` / `data.strokeSize`.
 *
 * The component itself is presentation-only. It does not know about the
 * store; the parent decides where the values come from and where edits go.
 */
export function SketchControls({
  color,
  size,
  onColorChange,
  onSizeChange,
}: SketchControlsProps) {
  return (
    <>
      <FloatingToolbar.ColorPicker
        colors={SKETCH_COLOR_OPTIONS}
        value={color}
        onSelect={onColorChange}
        title="Stroke color"
      />
      <span
        className="text-fg-subtle min-w-6 text-center text-xs tabular-nums"
        title="Stroke thickness"
      >
        {size}
      </span>
      <input
        type="range"
        min={SKETCH_SIZE_MIN}
        max={SKETCH_SIZE_MAX}
        value={size}
        onChange={(e) => onSizeChange(Number(e.target.value))}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className={[
          // Base layout
          'h-4 w-24 cursor-pointer appearance-none bg-transparent',
          // WebKit / Blink — grey track, borderless thumb
          '[&::-webkit-slider-runnable-track]:bg-edge-default',
          '[&::-webkit-slider-runnable-track]:h-1',
          '[&::-webkit-slider-runnable-track]:rounded-full',
          '[&::-webkit-slider-runnable-track]:border-0',
          '[&::-webkit-slider-thumb]:appearance-none',
          '[&::-webkit-slider-thumb]:h-3.5',
          '[&::-webkit-slider-thumb]:w-3.5',
          '[&::-webkit-slider-thumb]:rounded-full',
          '[&::-webkit-slider-thumb]:bg-info',
          '[&::-webkit-slider-thumb]:border-0',
          '[&::-webkit-slider-thumb]:-mt-1.25',
          // Firefox — same look
          '[&::-moz-range-track]:bg-edge-default',
          '[&::-moz-range-track]:h-1',
          '[&::-moz-range-track]:rounded-full',
          '[&::-moz-range-track]:border-0',
          '[&::-moz-range-thumb]:h-3.5',
          '[&::-moz-range-thumb]:w-3.5',
          '[&::-moz-range-thumb]:rounded-full',
          '[&::-moz-range-thumb]:bg-info',
          '[&::-moz-range-thumb]:border-0',
        ].join(' ')}
        aria-label="Stroke thickness"
      />
    </>
  );
}
