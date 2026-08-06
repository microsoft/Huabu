import type { ColorPickerOption } from '@sediment/shared';
import type { TFunction } from 'i18next';

export function translateColorOptions(
  options: readonly ColorPickerOption[],
  t: TFunction,
): ColorPickerOption[] {
  return options.map((option) => ({
    ...option,
    name: t(`colors.${option.token}`, { defaultValue: option.name }),
  }));
}
