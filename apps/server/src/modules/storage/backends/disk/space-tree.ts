// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The Disk backend's real directory for one Space.
 *
 * **Not a port, and deliberately not in `ports/`.** `StructuredStore` and
 * `BlobStore` are the whole portable surface. A Space directory is Disk's, and
 * a backend that keeps Spaces in tables does not have one; making every
 * backend promise a directory would mean fabricating one, which moves the
 * failure somewhere less obvious than the refusal
 * (docs/proposals/multi-backend-storage.md §6.4.1, §12.6.2).
 *
 * It reaches consumers as `space(canvasId).diskTree`, typed by its absence —
 * `null` on any other backend — so a caller is told the truth once, at the
 * same handle it asks every other storage question. The fence that keeps an
 * unportable capability from reading as a portable one is the name and the
 * enumerated consumer list in `module-boundaries.test.ts`, not the shape of
 * the accessor.
 */

import path from 'node:path';

import { canvasRoot } from './layout.js';
import { getWorkspacePath } from '../../../workspace.js';

export interface DiskSpaceTree {
  readonly canvasId: string;
  /**
   * Absolute path to this Space's directory in the Workspace this tree was
   * resolved in.
   *
   * A method rather than a property because it is not a constant: the
   * directory name is derived from the Space's title, so a Finder-side rename
   * moves it. Resolving per call keeps a retained tree from handing back a
   * path that was true when the handle was made. It raises rather than
   * improvising when the id is malformed or the resolved path escapes the
   * Workspace.
   *
   * A Workspace switch does not move a retained tree, it invalidates it: the
   * whole Space handle is scoped to the Workspace that was active when it was
   * resolved (`StructuredStore.space`), and a directory that followed
   * activation would answer a question about one Workspace with another
   * Workspace's files while its sibling members rejected. Resolve a fresh
   * handle instead.
   */
  directory(): string;
}

export function diskSpaceTree(canvasId: string): DiskSpaceTree {
  // Bound at resolution, exactly as `DiskSpaceNodes` binds its own: one Space
  // handle answers about one Workspace, on every member.
  const workspacePath = path.resolve(getWorkspacePath());
  return {
    canvasId,
    directory: () => {
      if (path.resolve(getWorkspacePath()) !== workspacePath) {
        throw new Error(
          `DiskSpaceTree(${canvasId}) belongs to an inactive workspace. ` +
            'Resolve a fresh Space handle after workspace activation.',
        );
      }
      return canvasRoot(canvasId);
    },
  };
}
