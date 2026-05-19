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
}

// Track + thumb styles are identical across size variants — the size
// preset only changes the outer input box and readout font. Pulled out
// into a single constant string of literal class names so Tailwind's
// JIT still picks them up (no runtime interpolation of class fragments).
const SLIDER_TRACK_AND_THUMB = [
  // WebKit / Blink — grey track, borderless thumb
  '[&::-webkit-slider-runnable-track]:bg-edge-default',
  '[&::-webkit-slider-runnable-track]:h-1.5',
  '[&::-webkit-slider-runnable-track]:rounded-full',
  '[&::-webkit-slider-runnable-track]:border-0',
  '[&::-webkit-slider-thumb]:appearance-none',
  '[&::-webkit-slider-thumb]:h-4',
  '[&::-webkit-slider-thumb]:w-4',
  '[&::-webkit-slider-thumb]:rounded-full',
  '[&::-webkit-slider-thumb]:bg-info',
  '[&::-webkit-slider-thumb]:border-0',
  '[&::-webkit-slider-thumb]:-mt-1',
  // Firefox — same look
  '[&::-moz-range-track]:bg-edge-default',
  '[&::-moz-range-track]:h-1.5',
  '[&::-moz-range-track]:rounded-full',
  '[&::-moz-range-track]:border-0',
  '[&::-moz-range-thumb]:h-4',
  '[&::-moz-range-thumb]:w-4',
  '[&::-moz-range-thumb]:rounded-full',
  '[&::-moz-range-thumb]:bg-info',
  '[&::-moz-range-thumb]:border-0',
].join(' ');

// Size-specific outer dimensions / readout font — must be literal so
// Tailwind's JIT can pick them up (no dynamic concatenation).
const SIZE_STYLES = {
  sm: { input: 'h-5 w-28', readout: 'text-xs min-w-5' },
  md: { input: 'h-6 w-36', readout: 'text-sm min-w-6' },
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
}: RangeSliderProps) {
  const styles = SIZE_STYLES[size];
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
        onPointerDown={(e) => e.stopPropagation()}
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
