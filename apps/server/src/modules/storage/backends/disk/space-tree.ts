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

import { canvasRoot, nodesDir } from './layout.js';
import { getCanvasStore } from './legacy/canvas-store-cache.js';
import { getWorkspacePath } from '../../../workspace.js';

/** A node sidecar, as RFS and the file tools address one. */
const NODE_SIDECAR_RE = /^nodes\/([^/]+\.md)$/;

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
  /**
   * Which node record the materialized file at `relativePath` carries.
   *
   * `relativePath` is Space-relative (`nodes/My note.md`); anything that is
   * not a node sidecar, and any name no node currently claims, returns `null`.
   *
   * This is the **sidecar-to-record mapping**, and it belongs to the tree
   * rather than to a port for the reason §6.4.3 gives under disposition B:
   * every backend could mint `nodes/<label>.md` names from records, but Disk
   * inverts the *real* filename, because the file is really there and a user
   * may have renamed it. The two are only the same answer when nothing has
   * touched the directory from outside — which is exactly the case Disk
   * cannot assume. Until a second backend exists, RFS's file plane is Disk's.
   *
   * Resolved through the frontmatter-`id` index rather than by re-deriving
   * `toSafeFilename(label)`: topology never carries a label, so a derived path
   * would collapse to `nodes/<id>.md` and never match a label-named file.
   */
  nodeIdForPath(relativePath: string): string | null;
  /**
   * Where this Space's node sidecars are, for a feature that shows a user
   * their own files.
   *
   * `directory()` plus a segment the caller would otherwise have to know. The
   * point of the capability is that the layout has one owner, so a consumer
   * asking "which folder holds the notes" gets an answer rather than assembles
   * one.
   */
  nodesDirectory(): string;
  /**
   * Every sidecar filename currently claiming `nodeId`; empty when there is
   * no conflict.
   *
   * Only a filesystem can produce this: two files can both say they are one
   * node, and a table with a primary key cannot. The read path surfaces it as
   * a non-blocking hint — the index keeps the last-scanned file, so the node
   * still renders — while a write hard-fails with `duplicate-node`. That
   * asymmetry is deliberate: a user who broke it by hand needs to see the node
   * to fix it.
   */
  duplicateSidecars(nodeId: string): readonly string[];
}

export function diskSpaceTree(canvasId: string): DiskSpaceTree {
  // Bound at resolution, exactly as `DiskSpaceNodes` binds its own: one Space
  // handle answers about one Workspace, on every member.
  const workspacePath = path.resolve(getWorkspacePath());
  const assertActiveWorkspace = (): void => {
    if (path.resolve(getWorkspacePath()) !== workspacePath) {
      throw new Error(
        `DiskSpaceTree(${canvasId}) belongs to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }
  };
  return {
    canvasId,
    directory: () => {
      assertActiveWorkspace();
      return canvasRoot(canvasId);
    },
    nodesDirectory: () => {
      assertActiveWorkspace();
      return nodesDir(canvasId);
    },
    nodeIdForPath: (relativePath: string) => {
      assertActiveWorkspace();
      const filename = NODE_SIDECAR_RE.exec(relativePath)?.[1];
      if (filename === undefined) return null;
      return getCanvasStore(canvasId).nodeIdForFilename(filename);
    },
    duplicateSidecars: (nodeId: string) => {
      assertActiveWorkspace();
      const store = getCanvasStore(canvasId);
      return store.isDuplicateNode(nodeId)
        ? store.duplicateNodeFiles(nodeId)
        : [];
    },
  };
}
