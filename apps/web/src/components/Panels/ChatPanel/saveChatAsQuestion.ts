// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';
import type { PreviewTarget } from '@/store/previewWorkspace/model';
import type { CanvasNodeId } from '@huabu/shared';

export function saveChatAsQuestion(
  input: AddNodeInput & { id: CanvasNodeId },
  options: {
    canvasId: string;
    previewTabId: string;
    addNode: (input: AddNodeInput) => void;
    nodeExists: (nodeId: string) => boolean;
    replaceTabTarget: (tabId: string, target: PreviewTarget) => void;
  },
): boolean {
  options.addNode(input);
  if (!options.nodeExists(input.id)) return false;

  options.replaceTabTarget(options.previewTabId, {
    kind: 'node',
    canvasId: options.canvasId,
    nodeId: input.id,
  });
  return true;
}
