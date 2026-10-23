// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import useCanvasStore from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

export const REQUEST_CREATE_CHILD_SPACE = 'huabu:create-child-space';
export interface CreateChildSpaceIntent {
  canvasId: string;
  workspaceId: string | null;
  nodeIds: string[];
  position?: { x: number; y: number };
}

export function requestCreateChildSpace(
  position?: { x: number; y: number },
  nodeIds = useCanvasStore
    .getState()
    .nodes.filter((node) => node.selected)
    .map((node) => node.id),
): void {
  const { canvasId } = useCanvasStore.getState();
  const { workspaceId, worldCanvasId } = useWorkspaceStore.getState();
  if (canvasId === worldCanvasId || (!position && nodeIds.length === 0)) return;
  window.dispatchEvent(
    new CustomEvent<CreateChildSpaceIntent>(REQUEST_CREATE_CHILD_SPACE, {
      detail: { canvasId, workspaceId, nodeIds, position },
    }),
  );
}
