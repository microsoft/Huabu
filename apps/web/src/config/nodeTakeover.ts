// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { NODE_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';
import { QUESTION_NODE_DEFAULT_FONT_SIZE } from '@/utils/node/nodeFontConfig';

/** Question-only authored takeover geometry; viewport zoom never changes it. */
export const QUESTION_TAKEOVER_SIZE = 128;
export const QUESTION_TAKEOVER_AVATAR_RATIO = 0.66;
export const QUESTION_TAKEOVER_CARD_RATIO = 0.75;
export const QUESTION_TAKEOVER_FONT_THRESHOLDS = {
  enter: 5,
  exit: 5.5,
} as const;
export const TAKEOVER_GLIDE_MS = 200;
export type QuestionLodStage = 'readable' | 'collapsed';
export interface TakeoverPoint {
  x: number;
  y: number;
}
export interface TakeoverState {
  stage: QuestionLodStage;
  progress?: number;
  /** Screen size of the authored footprint, not the visible bounds. */
  size: number;
  /** Visible bounding-square diameter divided by authored footprint size. */
  onBoundsChange?: (ratio: number) => void;
}
export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function questionTakeoverContentScale(fontSize: unknown): number {
  return typeof fontSize === 'number' &&
    Number.isFinite(fontSize) &&
    fontSize > 0
    ? fontSize / NODE_TYPOGRAPHY.cardTitle.size
    : 1;
}
export function resolveQuestionStage(
  prev: QuestionLodStage,
  zoom: number,
  fontSize = QUESTION_NODE_DEFAULT_FONT_SIZE,
): QuestionLodStage {
  const threshold = QUESTION_TAKEOVER_FONT_THRESHOLDS;
  return zoom <
    (prev === 'collapsed' ? threshold.exit : threshold.enter) / fontSize
    ? 'collapsed'
    : 'readable';
}
/** Centered canvas-space blend; zoom is retained only for call compatibility. */
export function localMarkRect(
  width: number,
  height: number,
  _zoom: number,
  glide: number,
  diameter = QUESTION_TAKEOVER_SIZE * QUESTION_TAKEOVER_AVATAR_RATIO,
): { x: number; y: number; width: number; height: number } {
  const g = clamp01(glide);
  return {
    x: lerp(0, (width - diameter) / 2, g),
    y: lerp(0, (height - diameter) / 2, g),
    width: lerp(width, diameter, g),
    height: lerp(height, diameter, g),
  };
}
