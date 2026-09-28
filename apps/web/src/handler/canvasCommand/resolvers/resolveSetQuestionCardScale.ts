// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getNodeFontFit } from '@/utils/node/fontFit';
import { QUESTION_NODE_DEFAULT_FONT_SIZE } from '@/utils/node/nodeFontConfig';

import { extractNodeRef } from '../utils';

import type {
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';
import type { CanvasNodeId } from '@huabu/shared';

/** Shared UI limits: reject rather than clamp, including fractional inputs. */
export const QUESTION_CARD_SCALE_RANGE = { min: 10, max: 1000 } as const;

/**
 * Resolve an absolute card scale without rounding or mutating live state.
 * Callers must preflight no-ops before beginGesture('SET_NODE_GEOMETRY'); the
 * existing mixed-command snapshot policy then records exactly one undo step.
 */
export function resolveSetQuestionCardScale(
  intent: Extract<CanvasUiIntent, { type: 'SET_QUESTION_CARD_SCALE' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const { nodeId, percent } = intent;
  if (
    !Number.isFinite(percent) ||
    percent < QUESTION_CARD_SCALE_RANGE.min ||
    percent > QUESTION_CARD_SCALE_RANGE.max
  ) {
    return { commands: [], trace: [] };
  }

  const node = ui.nodes.find((candidate) => candidate.id === nodeId);
  if (node?.type !== 'question') return { commands: [], trace: [] };

  // getNodeFontFit reads the outer width through canonical getNodeSize.
  const current = getNodeFontFit(node);
  const fontSize = (QUESTION_NODE_DEFAULT_FONT_SIZE * percent) / 100;
  if (
    !current ||
    !Number.isFinite(current.width) ||
    current.width <= 0 ||
    fontSize === current.fontSize
  ) {
    return { commands: [], trace: [] };
  }
  const width = (current.width * fontSize) / current.fontSize;
  if (!Number.isFinite(width) || width <= 0) {
    return { commands: [], trace: [] };
  }

  return {
    commands: [
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          { nodeId: nodeId as CanvasNodeId, patch: { style: { fontSize } } },
        ],
      },
      {
        type: 'SET_NODE_GEOMETRY',
        items: [
          { nodeId: nodeId as CanvasNodeId, size: { width, height: 'auto' } },
        ],
      },
    ],
    trace: [{ action: 'node_edited', node: extractNodeRef(node) }],
  };
}
