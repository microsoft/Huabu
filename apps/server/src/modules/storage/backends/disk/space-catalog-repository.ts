// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Disk implementation of the read-only Space catalogue. */

import path from 'node:path';

import {
  listCanvasDirEntries,
  refreshCanvasDirIndex,
  requireWorldCanvasId,
} from '../../../workspace/disk/canvas-dirs.js';
import { toSafeFilename } from '../../../workspace/disk/naming.js';
import { getWorkspacePath } from '../../../workspace.js';

import type { SpaceCatalogRepository } from '../../ports/structured.js';
import type { CanvasSummary } from '@huabu/shared';

/**
 * A catalogue handle is bound to the Workspace active at construction time.
 * Both reads rescan so external imports, deletes, and Finder renames are
 * visible without an explicit cache invalidation call.
 */
export class DiskSpaceCatalogRepository implements SpaceCatalogRepository {
  private readonly workspacePath = path.resolve(getWorkspacePath());

  async list(): Promise<CanvasSummary[]> {
    this.assertActiveWorkspace();
    refreshCanvasDirIndex();

    return listCanvasDirEntries().map((entry) => {
      const expectedDir = toSafeFilename(entry.title, entry.id);
      const title =
        entry.filename && entry.filename !== expectedDir
          ? entry.filename
          : entry.title;
      return {
        canvasId: entry.id,
        title,
        nodeCount: entry.nodeCount ?? 0,
        createdAt: entry.createdAt ?? 0,
        updatedAt: entry.updatedAt ?? 0,
      };
    });
  }

  async worldId(): Promise<string> {
    this.assertActiveWorkspace();
    refreshCanvasDirIndex();
    return requireWorldCanvasId();
  }

  private assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) === this.workspacePath) return;
    throw new Error(
      'Space catalogue belongs to an inactive workspace. Resolve a fresh catalogue handle.',
    );
  }
}
