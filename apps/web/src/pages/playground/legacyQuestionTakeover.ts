// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { clamp01 } from '@/config/nodeTakeover';

import type { QuestionLodStage } from '@/config/nodeTakeover';

/** Historical screen-space geometry for archived playground proposals only. */
export function collapseProgress(width: number): number {
  const t = clamp01((64 - width) / 40);
  return t * t * (3 - 2 * t);
}

export function collapsedMarkSize(width: number, height: number): number {
  const shortSide = Math.min(Math.max(0, width), Math.max(0, height));
  return 6 + 24 * Math.pow(clamp01((shortSide - 4) / 26), 0.7);
}

export function badgeSizeForNode(width: number, height: number): number {
  return Math.max(30, Math.min(84, 0.28 * Math.min(width, height)));
}

export function resolveLegacyQuestionStage(
  previous: QuestionLodStage,
  width: number,
): QuestionLodStage {
  if (previous === 'readable') return width < 58 ? 'collapsed' : 'readable';
  return width >= 70 ? 'readable' : 'collapsed';
}
