// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { NODE_SHELL_INSET } from '@huabu/shared/canvas-engine';

import { getAccentTokens, isWhiteAccent } from './accentTokens';

export const NODE_BORDER_WIDTH = NODE_SHELL_INSET / 2;

/** Card layout inset, not painted stroke width; Frame surfaces stay separate. */
export function nodeLayoutBorderInset(type: string | undefined): number {
  return type === 'image' || type === 'video' || type === 'sketch'
    ? 0
    : NODE_BORDER_WIDTH;
}

export function nodeBoundaryForAccent(accent: string | null) {
  const color =
    accent && !isWhiteAccent(accent)
      ? getAccentTokens(accent).border
      : 'var(--edge-default)';
  return {
    borderColor: color,
    borderWidth: NODE_BORDER_WIDTH,
  };
}
