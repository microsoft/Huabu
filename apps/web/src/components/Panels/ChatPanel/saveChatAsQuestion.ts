// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';
import type { PreviewTarget } from '@/store/previewWorkspace/model';
import type { CanvasNodeId, ConversationTitle } from '@huabu/shared';

export function saveChatAsQuestion(
  input: AddNodeInput & { id: CanvasNodeId },
  options: {
    canvasId: string;
    previewTabId: string;
    conversationTitle?: ConversationTitle;
    addNode: (input: AddNodeInput) => void;
    nodeExists: (nodeId: string) => boolean;
    replaceTabTarget: (tabId: string, target: PreviewTarget) => void;
  },
): boolean {
  const title = options.conversationTitle;
  options.addNode({
    ...input,
    data: {
      ...input.data,
      // Transfer naming provenance; automatic names continue through the backend service.
      ...(title?.title
        ? {
            label: title.title,
            labelSource: title.source === 'user' ? 'user' : 'auto',
            conversationTitleSource: title.source,
          }
        : {}),
    },
  });
  if (!options.nodeExists(input.id)) return false;

  options.replaceTabTarget(options.previewTabId, {
    kind: 'node',
    canvasId: options.canvasId,
    nodeId: input.id,
  });
  return true;
}
