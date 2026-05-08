import { clsx } from 'clsx';

/**
 * One selectable entry in a `ColorPicker`.
 * - `token`: stable identifier persisted to canvas data.
 * - `name`:  display label shown as a tooltip.
 * - `value`: CSS color used to render the swatch (hex / keyword / `var(...)`).
 */
export interface ColorPreset {
  token: string;
  name: string;
  value: string;
}

export interface ColorPickerProps {
  colors: readonly ColorPreset[];
  /** Currently selected token (matches `ColorPreset.token`). */
  activeToken: string | null | undefined;
  /** Called with the picked token. */
  onSelect: (token: string) => void;
}

/**
 * Reusable color picker palette — a row of circular swatches.
 * Identity is by `token`; the swatch background uses `value` for display only.
 */
export const ColorPicker = ({
  colors,
  activeToken,
  onSelect,
}: ColorPickerProps) => {
  return (
    <div className="flex gap-2">
      {colors.map((c) => (
        <button
          key={c.token}
          onClick={() => onSelect(c.token)}
          className={clsx(
            'h-4 w-4 rounded-full border-2 transition-all hover:scale-110',
            activeToken === c.token
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
