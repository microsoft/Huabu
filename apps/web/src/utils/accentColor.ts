// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  isAccentToken,
  resolveAccent,
  type AccentToken,
  type ColorPickerOption,
} from '@huabu/shared';

/** Resolve only at the rendering boundary; persisted colors stay tokens or literals. */
export function resolveAccentCss(input: AccentToken): string;
export function resolveAccentCss(
  input: string | null | undefined,
): string | null;
export function resolveAccentCss(
  input: string | null | undefined,
): string | null {
  if (!input) return null;
  return isAccentToken(input)
    ? `light-dark(${resolveAccent(input)}, ${resolveAccent(input, 'dark')})`
    : input;
}

/** Keep caller-supplied highlight swatches; theme only the palette's raw swatches. */
export function resolveColorPresetCss(
  preset: Pick<ColorPickerOption, 'token' | 'value'>,
): string {
  return isAccentToken(preset.token) &&
    preset.value === resolveAccent(preset.token)
    ? resolveAccentCss(preset.token)
    : preset.value;
}
