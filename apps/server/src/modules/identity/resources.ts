// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  getWorkspaceRepository,
  openWorkspace,
  space,
} from '../storage/index.js';
import { runInWorkspace } from '../workspace/context.js';
import { createWorkspace } from '../workspace-activation.js';
import { getProcessWorkspaceHandle } from '../workspace.js';

import type { ResourceDirectory } from './service.js';

/**
 * Huabu storage as the identity provider sees it. A Space is found in the
 * Workspace its grant names, World included, whichever Workspace the caller is
 * in. A child Space sits under its parent Space, so whoever may use a Space
 * may use the Spaces inside it.
 */
export const storageResourceDirectory: ResourceDirectory = {
  async workspaceExists(workspaceId) {
    return (await getWorkspaceRepository().get(workspaceId)) !== null;
  },
  async spaceParent(workspaceId, canvasId) {
    const workspace = await getWorkspaceRepository().get(workspaceId);
    if (!workspace) return null;
    const scope = await openWorkspace(workspace);
    const record = await runInWorkspace(scope, () => space(canvasId).read());
    if (!record) return null;
    return record.parentSpaceId
      ? { type: 'space', id: record.parentSpaceId }
      : { type: 'workspace', id: workspaceId };
  },
  async workspaceOfSpace(canvasId) {
    for (const workspace of await getWorkspaceRepository().list()) {
      const scope = await openWorkspace(workspace);
      if (await runInWorkspace(scope, () => space(canvasId).read()))
        return workspace.workspaceId;
    }
    return null;
  },
  async openWorkspace(workspaceId) {
    const workspace = await getWorkspaceRepository().get(workspaceId);
    return workspace ? openWorkspace(workspace) : null;
  },
  async defaultWorkspace() {
    const workspace =
      getProcessWorkspaceHandle() ?? (await getWorkspaceRepository().list())[0];
    return workspace ? openWorkspace(workspace) : null;
  },
  async createWorkspace(name) {
    return openWorkspace(await createWorkspace(name));
  },
};
