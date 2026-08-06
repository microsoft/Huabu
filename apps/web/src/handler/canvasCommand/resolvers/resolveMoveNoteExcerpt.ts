// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import resolveAddNodes from './resolveAddNodes';

import type {
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';
import type { CanvasCommand, CanvasNodeId } from '@huabu/shared';

export default function resolveMoveNoteExcerpt(
  intent: Extract<CanvasUiIntent, { type: 'MOVE_NOTE_EXCERPT' }>,
  ui: UiResolverState,
): UiIntentResolution {
  // Reuse ADD_NODES so the new note shares placement (frame nesting,
  // viewport-centre fallback) and trace plumbing with every other
  // drag-drop create.
  const addResolution = resolveAddNodes(
    { type: 'ADD_NODES', inputs: [intent.newNote] },
    ui,
  );

  const sourceNode = ui.nodes.find((n) => n.id === intent.sourceNodeId);
  const sourceIsNote = sourceNode?.type === 'note';
  // Degrade to a plain add when the source is gone or no longer a note.
  if (!sourceIsNote) return addResolution;

  const currentContent = (sourceNode.data as { content?: unknown } | undefined)
    ?.content;
  if (
    typeof currentContent === 'string' &&
    currentContent === intent.sourceContentAfterMove
  ) {
    return addResolution;
  }

  const patchCommand: CanvasCommand = {
    type: 'MERGE_NODE_DATA',
    patches: [
      {
        nodeId: intent.sourceNodeId as CanvasNodeId,
        patch: { content: intent.sourceContentAfterMove },
      },
    ],
  };

  return {
    ...addResolution,
    commands: [...addResolution.commands, patchCommand],
  };
}
