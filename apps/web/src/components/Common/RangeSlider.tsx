// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef } from 'react';

type RangeSliderSize = 'sm' | 'md';

interface RangeSliderProps {
  value: number;
  min: number;
  max: number;
  /** Optional step; defaults to `1`. */
  step?: number;
  /** Used for the tooltip + aria-label so screen readers know its role. */
  label: string;
  /**
   * Visual size preset. `'sm'` (default) is compact and fits inside
   * node floating toolbars; `'md'` is a roomier variant used in tool
   * settings panels where there's more space.
   */
  size?: RangeSliderSize;
  /**
   * When `true` (default), renders a small numeric readout next to the
   * slider that mirrors the current value. Disable for compact contexts
   * where the parent already shows the value elsewhere.
   */
  showValue?: boolean;
  onChange: (value: number) => void;
  /**
   * Fired once when a drag / keyboard interaction begins (before the first
   * `onChange`). Lets a consumer open a single undo gesture that the
   * per-tick `onChange` writes fold into. Paired with {@link onDragEnd}.
   */
  onDragStart?: () => void;
  /**
   * Fired once when the interaction ends (pointer up / cancel / blur, or on
   * unmount as a safety net) so the consumer can close the undo gesture.
   */
  onDragEnd?: () => void;
}

// Shared track + thumb colors. Thumb dimensions live in SIZE_STYLES so the
// desktop control can stay visually light while touch keeps a larger handle.
const SLIDER_TRACK_AND_THUMB = [
  // WebKit / Blink — grey track, borderless thumb
  '[&::-webkit-slider-runnable-track]:bg-edge-default',
  '[&::-webkit-slider-runnable-track]:h-1.5',
  '[&::-webkit-slider-runnable-track]:rounded-full',
  '[&::-webkit-slider-runnable-track]:border-0',
  '[&::-webkit-slider-thumb]:appearance-none',
  '[&::-webkit-slider-thumb]:rounded-full',
  '[&::-webkit-slider-thumb]:bg-info',
  '[&::-webkit-slider-thumb]:border-0',
  // Firefox — same look
  '[&::-moz-range-track]:bg-edge-default',
  '[&::-moz-range-track]:h-1.5',
  '[&::-moz-range-track]:rounded-full',
  '[&::-moz-range-track]:border-0',
  '[&::-moz-range-thumb]:rounded-full',
  '[&::-moz-range-thumb]:bg-info',
  '[&::-moz-range-thumb]:border-0',
].join(' ');

// Size-specific outer dimensions / readout font — must be literal so
// Tailwind's JIT can pick them up (no dynamic concatenation).
const SIZE_STYLES = {
  sm: {
    input:
      'h-5 w-28 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:-mt-[3px] [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3',
    readout: 'text-xs min-w-5',
  },
  md: {
    input:
      'h-6 w-36 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:-mt-1 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4',
    readout: 'text-sm min-w-6',
  },
} as const satisfies Record<
  RangeSliderSize,
  { input: string; readout: string }
>;

/**
 * Compact range input + optional numeric readout, styled to match the
 * floating toolbar / settings-panel look (grey track, info-colored thumb).
 *
 * Presentation-only and width-stable so it can live inside fixed-width
 * toolbars without causing layout jitter while dragging.
 */
export function RangeSlider({
  value,
  min,
  max,
  step = 1,
  label,
  size = 'sm',
  showValue = true,
  onChange,
  onDragStart,
  onDragEnd,
}: RangeSliderProps) {
  const styles = SIZE_STYLES[size];
  // Bracket a drag / key interaction so start + end fire exactly once even
  // though the browser emits several terminal events (pointerup +
  // lostpointercapture + blur). A ref (not state) keeps this render-free.
  const activeRef = useRef(false);
  const begin = () => {
    if (activeRef.current) return;
    activeRef.current = true;
    onDragStart?.();
  };
  const end = () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    onDragEnd?.();
  };
  // Safety net: if the slider unmounts mid-drag (e.g. its toolbar closes),
  // still close the gesture so the armed undo bracket never leaks.
  useEffect(() => end, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          e.stopPropagation();
          begin();
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyDown={begin}
        onKeyUp={end}
        onBlur={end}
        title={`${label}: ${value}`}
        className={`${styles.input} cursor-pointer appearance-none bg-transparent ${SLIDER_TRACK_AND_THUMB}`}
        aria-label={label}
      />
      {showValue ? (
        <span
          className={`text-fg-subtle text-center tabular-nums ${styles.readout}`}
          title={label}
        >
          {value}
        </span>
      ) : null}
    </>
  );
}
