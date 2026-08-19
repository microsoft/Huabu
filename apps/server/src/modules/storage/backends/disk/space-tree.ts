// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The Disk backend's Space directory, for consumers that need a real one.
 *
 * **This is a Disk capability, not a portable one, and it is not a port.**
 * `StructuredStore` and `BlobStore` are the two ports; everything portable
 * goes through them. What lives here is the residue: features that today
 * reach a Space as a filesystem tree — RFS projecting a directory listing,
 * the external-note watcher arming `fs.watch`, the built-in file tools
 * rooting a sandbox, the agent domain keeping `.memory/` and ACP sessions
 * beside a Space.
 *
 * Those are not portable requirements and must not be dressed up as if they
 * were. A backend that keeps Spaces in tables has no directory to hand out
 * and would have to fabricate one; a capability absent from a backend is an
 * acceptable outcome, and the honest one. The route out is for those features
 * to stop needing a tree — an agent can reach a Space over Huabu's HTTP API
 * instead of a projected filesystem — not for storage to promise every
 * backend a directory.
 *
 * So this is deliberately reached by a name with `disk` in it, exported from
 * exactly one place, and enumerated by `module-boundaries.test.ts` so the
 * consumer list can only shrink. Every entry on that list is a reason a
 * non-Disk structured profile is not selectable.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  refreshCanvasDirIndex,
  registerCanvasDir,
  suggestCanvasDir,
} from './canvas-dirs.js';
import { canvasRoot, SPACE_JSON_FILENAME } from './layout.js';
import { getCanvasStore } from './legacy/canvas-store-cache.js';
import {
  registerSpaceDirHandleOwner,
  type SpaceDirHandleOwner,
} from './space-dir-handles.js';
import { sanitizeId } from '../../../../utils/fs.js';
import { toSafeFilename } from '../../../../utils/naming.js';
import { getWorkspacePath } from '../../../workspace.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';

/** Space-relative markdown node file; capture group is the bare filename. */
const NODE_FILE_RE = /^nodes\/([^/]+\.md)$/;

/** One Space's directory under the Disk layout. */
export interface DiskSpaceTree {
  readonly canvasId: string;
  /** Absolute root of this Space's directory. */
  directory(): string;
  /** Absolute path to the node-sidecar directory. */
  nodesDirectory(): string;
  /**
   * The node whose sidecar is `relativePath`, or null when none is.
   *
   * A node is filed under its *label*, so the name cannot be inverted — only
   * the sidecar index knows. Reading the id out of the file's frontmatter
   * instead would spread Disk's record encoding into whoever asked.
   */
  nodeIdForPath(relativePath: string): Promise<string | null>;
  /** Register a live native handle that must be released for rename/delete. */
  registerHandleOwner(owner: SpaceDirHandleOwner): () => void;
}

/** An uploaded bundle staged outside the Space namespace until published. */
export interface DiskSpaceImport {
  readonly canvasId: string;
  readonly directory: string;
  /**
   * Adopt the staged directory as this Space's directory.
   *
   * Returns the record as written. The title may come back adjusted: the
   * directory name is derived from it and the name may already be taken, so
   * callers must use the returned record rather than the one they passed in.
   */
  publish(record: CanvasFile): Promise<CanvasFile>;
  /** Remove the unpublished staging directory. Idempotent after publish. */
  discard(): Promise<void>;
}

export class DiskSpaceTrees {
  readonly #workspacePath: string;

  constructor(workspacePath = getWorkspacePath()) {
    this.#workspacePath = path.resolve(workspacePath);
    try {
      if (path.resolve(getWorkspacePath()) === this.#workspacePath) {
        refreshCanvasDirIndex();
      }
    } catch {
      // Staged mounts are constructed before their Workspace becomes active.
    }
  }

  /**
   * Refresh the process-local directory index after a Workspace commit.
   *
   * Called once the new Workspace path is committed and before the mount is
   * swapped in, so it must not fail: it only drops a cache.
   */
  activate(): void {
    refreshCanvasDirIndex();
  }

  space(canvasId: string): DiskSpaceTree {
    const safeId = sanitizeId(canvasId, 'canvasId');
    const assertActive = (): void => {
      if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
        throw new Error(
          `Space directory for "${safeId}" belongs to an inactive workspace. Resolve a fresh one after workspace activation.`,
        );
      }
    };
    return Object.freeze({
      canvasId: safeId,
      directory: (): string => {
        assertActive();
        return canvasRoot(safeId);
      },
      nodesDirectory: (): string => {
        assertActive();
        return path.join(canvasRoot(safeId), 'nodes');
      },
      nodeIdForPath: async (relativePath: string): Promise<string | null> => {
        assertActive();
        const filename = NODE_FILE_RE.exec(relativePath)?.[1];
        if (filename === undefined) return null;
        return getCanvasStore(safeId).nodeIdForFilename(filename);
      },
      registerHandleOwner: (owner: SpaceDirHandleOwner): (() => void) => {
        assertActive();
        return registerSpaceDirHandleOwner(safeId, owner);
      },
    });
  }

  async stageImport(canvasId: string): Promise<DiskSpaceImport> {
    this.#assertActive();
    const safeId = sanitizeId(canvasId, 'canvasId');
    const stagingDirectory = path.join(
      this.#workspacePath,
      `.import-${safeId}`,
    );
    await mkdir(stagingDirectory, { recursive: true });
    let published = false;

    return Object.freeze({
      canvasId: safeId,
      directory: stagingDirectory,
      publish: async (record: CanvasFile): Promise<CanvasFile> => {
        if (published) throw new Error('Imported Space was already published');
        this.#assertActive();
        if (record.canvasId !== safeId) {
          throw new Error(
            `Imported Space id mismatch: expected ${safeId}, received ${record.canvasId}`,
          );
        }

        const requestedTitle = record.title ?? 'Imported canvas';
        const finalDirectoryName = suggestCanvasDir(requestedTitle, safeId);
        const safeFromTitle = toSafeFilename(requestedTitle, safeId);
        const dedupeSuffix =
          finalDirectoryName === safeFromTitle
            ? ''
            : finalDirectoryName.slice(safeFromTitle.length);
        const resolvedRecord: CanvasFile = {
          ...record,
          title:
            dedupeSuffix === ''
              ? requestedTitle
              : requestedTitle + dedupeSuffix,
        };

        await writeFile(
          path.join(stagingDirectory, SPACE_JSON_FILENAME),
          JSON.stringify(resolvedRecord),
        );
        await rm(path.join(stagingDirectory, 'canvas.json'), { force: true });
        await rename(
          stagingDirectory,
          path.join(this.#workspacePath, finalDirectoryName),
        );
        published = true;
        registerCanvasDir(safeId, finalDirectoryName, resolvedRecord.title);
        refreshCanvasDirIndex();
        return resolvedRecord;
      },
      discard: async (): Promise<void> => {
        if (published) return;
        await rm(stagingDirectory, { recursive: true, force: true });
      },
    });
  }

  #assertActive(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error('Cannot stage an import for an inactive Workspace');
    }
  }
}
