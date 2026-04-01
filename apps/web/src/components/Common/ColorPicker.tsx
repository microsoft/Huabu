import { clsx } from 'clsx';

export interface ColorPreset {
  name: string;
  /** Visual representation — either a CSS class like 'bg-red-50' or a hex value. */
  value: string;
  /** Tailwind border class for the swatch (only for class-based colors). */
  border?: string;
  /** Tailwind ring class when active (only for class-based colors). */
  ring?: string;
}

export interface ColorPickerProps {
  colors: ColorPreset[];
  /** Currently selected value (matches ColorPreset.value). */
  activeValue: string;
  onSelect: (value: string) => void;
  /** Whether color values are Tailwind classes (true) or raw hex strings (false). Default false. */
  classMode?: boolean;
}

/**
 * Reusable color picker palette — a row of circular swatches.
 * Supports two modes:
 *  - classMode: swatches rendered with Tailwind bg/border/ring classes (used for node background)
 *  - hex mode: swatches rendered with inline backgroundColor (used for edge stroke)
 */
export const ColorPicker = ({
  colors,
  activeValue,
  onSelect,
  classMode = false,
}: ColorPickerProps) => {
  if (classMode) {
    return (
      <div className="flex gap-2">
        {colors.map((c) => (
          <button
            key={c.name}
            onClick={() => onSelect(c.value)}
            className={clsx(
              'h-4 w-4 rounded-full border transition-all hover:scale-110',
              c.value,
              c.border ?? 'border-edge-default',
              activeValue === c.value && c.ring
                ? `ring-2 ${c.ring} ring-offset-1`
                : '',
            )}
            title={c.name}
          />
        ))}
      </div>
    );
  }

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
