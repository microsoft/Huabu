// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createChildSpace } from '@/api/spaceHierarchy';
import { toast } from '@/components/Common/Toast';
import { i18n } from '@/i18n';
import useCanvasStore, { drainPendingSaves } from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { pageLifecycle } from '@/utils/pageLifecycle';

import type { CreateChildSpaceBody } from '@huabu/shared';

export async function placeChildSpace(
  canvasId: string,
  position: NonNullable<CreateChildSpaceBody['position']>,
): Promise<string | undefined> {
  const workspaceId = useWorkspaceStore.getState().workspaceId;
  try {
    return await pageLifecycle.run('updating', async () => {
      await drainPendingSaves();
      if (
        useWorkspaceStore.getState().workspaceId !== workspaceId ||
        useCanvasStore.getState().canvasId !== canvasId
      ) {
        throw new Error(i18n.t('spaceHierarchy.workspaceChanged'));
      }
      const result = await createChildSpace(canvasId, {
        title: i18n.t('canvasList.untitled'),
        position,
      });
      if (useWorkspaceStore.getState().workspaceId !== workspaceId) return;
      await useWorkspaceStore
        .getState()
        .refreshSpaceTitles([canvasId, result.canvasId]);
      if (
        useCanvasStore.getState().canvasId === canvasId &&
        useWorkspaceStore.getState().workspaceId === workspaceId
      )
        return result.canvasId;
    });
  } catch (error) {
    toast(
      error instanceof Error ? error.message : i18n.t('spaceHierarchy.failed'),
      { tone: 'danger' },
    );
  }
}
