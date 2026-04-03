import { clsx } from 'clsx';

export interface ColorPreset {
  name: string;
  /** Visual representation — a hex value or CSS color keyword. */
  value: string;
}

export interface ColorPickerProps {
  colors: ColorPreset[];
  /** Currently selected value (matches ColorPreset.value). */
  activeValue: string;
  onSelect: (value: string) => void;
}

/**
 * Reusable color picker palette — a row of circular swatches.
 * All color values are hex strings or CSS color keywords rendered via
 * inline `backgroundColor`.
 */
export const ColorPicker = ({
  colors,
  activeValue,
  onSelect,
}: ColorPickerProps) => {
  return (
    <div className="flex gap-2">
      {colors.map((c) => (
        <button
          key={c.name}
          onClick={() => onSelect(c.value)}
          className={clsx(
            'h-4 w-4 rounded-full border-2 transition-all hover:scale-110',
            activeValue === c.value
              ? 'border-info scale-110'
              : 'border-edge-default',
          )}
          style={{
            backgroundColor: c.value || 'var(--fg-subtle)',
          }}
          title={c.name}
        />
      ))}
    </div>
  );
};
