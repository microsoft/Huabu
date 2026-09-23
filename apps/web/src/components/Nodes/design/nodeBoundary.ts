// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getAccentTokens } from './accentTokens';

export const NODE_BORDER_WIDTH = 3;

/** Card layout inset, not painted stroke width; Frame surfaces stay separate. */
export function nodeLayoutBorderInset(type: string | undefined): number {
  return type === 'image' || type === 'video' || type === 'sketch'
    ? 0
    : NODE_BORDER_WIDTH;
}

export function nodeBoundaryForAccent(accent: string | null) {
  return {
    borderColor: accent
      ? getAccentTokens(accent).divider
      : 'var(--edge-default)',
    borderWidth: NODE_BORDER_WIDTH,
  };
}
