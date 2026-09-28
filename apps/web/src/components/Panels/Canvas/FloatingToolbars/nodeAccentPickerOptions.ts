// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  ACCENT_PALETTE,
  ACCENT_NONE_TOKEN,
  ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
  type ColorPickerOption,
} from '@huabu/shared';

import {
  nodeAccentToken,
  nodeSupportsNoAccent,
} from '@/components/Nodes/design/nodeAccentPolicy';

/**
 * Only freeform content can remove its surface entirely. Structural and
 * document nodes always retain a surface, so a transparent swatch would
 * promise a result the renderer deliberately does not produce.
 */
export function nodeAccentPickerOptions(
  nodeTypes: readonly (string | undefined)[],
): readonly ColorPickerOption[] {
  return nodeTypes.length > 0 && nodeTypes.every(nodeSupportsNoAccent)
    ? ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT
    : ACCENT_PALETTE;
}

export function nodeAccentPickerValue(
  nodeType: string | undefined,
  accent: string | null | undefined,
): string {
  return nodeAccentToken(nodeType, accent) ?? ACCENT_NONE_TOKEN;
}
