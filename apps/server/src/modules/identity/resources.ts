// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getWorkspaceRepository, space } from '../storage/index.js';
import { getWorkspaceHandle } from '../workspace.js';

import type { ResourceDirectory } from './service.js';

/**
 * Huabu storage as the identity provider sees it. Only the active Workspace's
 * Spaces exist here, World included, so a Space in any other Workspace is
 * denied until Workspaces are served side by side. A child Space sits under
 * its parent Space, so whoever may use a Space may use the Spaces inside it.
 */
export const storageResourceDirectory: ResourceDirectory = {
  async workspaceExists(workspaceId) {
    return (await getWorkspaceRepository().get(workspaceId)) !== null;
  },
  async spaceParent(canvasId) {
    const workspaceId = getWorkspaceHandle()?.workspaceId;
    const record = workspaceId ? await space(canvasId).read() : null;
    if (!workspaceId || !record) return null;
    return record.parentSpaceId
      ? { type: 'space', id: record.parentSpaceId }
      : { type: 'workspace', id: workspaceId };
  },
};
