// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { ColorPickerOption } from '@huabu/shared';
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
