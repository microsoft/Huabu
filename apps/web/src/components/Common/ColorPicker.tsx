// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { clsx } from 'clsx';

import { Button } from './Button';

/**
 * One selectable entry in a `ColorPicker`.
 * - `token`: stable identifier persisted to canvas data.
 * - `name`:  display label shown by the common tooltip.
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
 *
 * Swatches whose `value` is `transparent` are rendered with a checkerboard
 * pattern so the "no fill / clear" option is visually distinct from a solid
 * white swatch.
 */
export const ColorPicker = ({
  colors,
  activeToken,
  onSelect,
}: ColorPickerProps) => {
  return (
    <div className="flex gap-2">
      {colors.map((c) => {
        const isTransparent = c.value === 'transparent' || !c.value;
        return (
          <Button
            key={c.token}
            variant="ghost"
            iconOnly
            size="sm"
            onClick={() => onSelect(c.token)}
            className={clsx(
              'h-4 w-4 rounded-full border-2 border-solid p-0 transition-transform hover:scale-110',
              activeToken === c.token
                ? 'border-info scale-110'
                : 'border-edge-default',
            )}
            style={
              isTransparent
                ? {
                    // Checkerboard pattern: makes "no fill" instantly
                    // recognisable instead of looking like a white swatch.
                    backgroundColor: 'var(--bg-surface)',
                    backgroundImage:
                      'linear-gradient(45deg, var(--fg-subtle) 25%, transparent 25%, transparent 75%, var(--fg-subtle) 75%), linear-gradient(45deg, var(--fg-subtle) 25%, transparent 25%, transparent 75%, var(--fg-subtle) 75%)',
                    backgroundSize: '6px 6px',
                    backgroundPosition: '0 0, 3px 3px',
                  }
                : { backgroundColor: c.value }
            }
            title={c.name}
            aria-label={c.name}
          >
            <span className="sr-only">{c.name}</span>
          </Button>
        );
      })}
    </div>
  );
};
