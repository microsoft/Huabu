// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type {
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';
import type { CanvasCommand, CanvasNodeId } from '@huabu/shared';

/**
 * Resolver for `MOVE_NOTE_BLOCK_INTO_NOTE`.
 *
 * Atomic cross-note block move: in a single undo entry, the source
 * note loses the dragged block (its `content` is replaced with the
 * caller-supplied `sourceContentAfterMove` snapshot) AND the target
 * note's `content` is replaced with `targetContentAfterInsert`
 * (which already has the dragged content stitched in by the caller).
 *
 * Mirrors `resolveMoveNoteExcerpt` shape — both produce a single
 * `MERGE_NODE_DATA` so the canvas command pipeline records one
 * undoable step.
 *
 * Degrades gracefully when the source or target node has disappeared
 * or is no longer a note: the patch for the missing side is dropped
 * silently. This keeps the user's intent (insert into target) intact
 * even when a stale source was wiped out by a concurrent edit.
 */
export default function resolveMoveNoteBlockIntoNote(
  intent: Extract<CanvasUiIntent, { type: 'MOVE_NOTE_BLOCK_INTO_NOTE' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const sourceNode = ui.nodes.find((n) => n.id === intent.sourceNodeId);
  const targetNode = ui.nodes.find((n) => n.id === intent.targetNodeId);

  const patches: Extract<
    CanvasCommand,
    { type: 'MERGE_NODE_DATA' }
  >['patches'] = [];

  const sourceIsNote = sourceNode?.type === 'note';
  if (sourceIsNote) {
    const currentContent = (
      sourceNode.data as { content?: unknown } | undefined
    )?.content;
    // Skip the source patch when the snapshot already matches — avoids
    // a redundant patch in the undo entry (e.g. drag-cancel scenarios
    // where the editor has already roundtripped through onChange).
    if (
      typeof currentContent !== 'string' ||
      currentContent !== intent.sourceContentAfterMove
    ) {
      patches.push({
        nodeId: intent.sourceNodeId as CanvasNodeId,
        patch: { content: intent.sourceContentAfterMove },
      });
    }
  }

  const targetIsNote = targetNode?.type === 'note';
  if (targetIsNote) {
    const currentContent = (
      targetNode.data as { content?: unknown } | undefined
    )?.content;
    if (
      typeof currentContent !== 'string' ||
      currentContent !== intent.targetContentAfterInsert
    ) {
      patches.push({
        nodeId: intent.targetNodeId as CanvasNodeId,
        patch: { content: intent.targetContentAfterInsert },
      });
    }
  }

  if (patches.length === 0) {
    return { commands: [], trace: [] };
  }

  return {
    commands: [{ type: 'MERGE_NODE_DATA', patches }],
    trace: [],
  };
}
