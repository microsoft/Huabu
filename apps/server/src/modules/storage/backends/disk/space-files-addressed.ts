// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Id-addressed materialization of the Space file capability.
 *
 * A Space lives at `<workspace>/<canvasId>/` and its nodes at
 * `<workspace>/<canvasId>/nodes/<nodeId>.md`. Nothing here consults a
 * structured record: the id in hand is the whole locator, which is what lets
 * this compose with a structured backend that keeps Spaces in tables and has
 * no per-directory record to scan.
 *
 * The trade it makes is legibility. Titles never reach the filesystem, so a
 * user browsing the Workspace sees opaque directory names and a Finder-side
 * rename means nothing — the title lives only in the structured record. That
 * is the right trade when the records are not files anyway, and the wrong one
 * for the Disk profile Huabu ships, which is why both exist.
 */

import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { registerSpaceDirHandleOwner } from './space-dir-handles.js';
import { sanitizeId } from '../../../../utils/fs.js';
import { getWorkspacePath } from '../../../workspace.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { StorageHealth } from '../../ports/common.js';
import type {
  SpaceFileHandleOwner,
  SpaceFileScope,
  SpaceFiles,
  SpaceImportStaging,
} from '../../ports/files.js';

/** Space-relative markdown node file; capture group is the bare filename. */
const NODE_FILE_RE = /^nodes\/([^/]+)\.md$/;

export class AddressedSpaceFiles implements SpaceFiles {
  readonly kind = 'disk-addressed' as const;
  readonly #workspacePath: string;

  constructor(workspacePath = getWorkspacePath()) {
    this.#workspacePath = path.resolve(workspacePath);
  }

  async init(): Promise<void> {}

  /**
   * Nothing to refresh: every locator is derived from the id and the
   * Workspace path this instance was built with, so there is no
   * process-global index that could be left describing the old Workspace.
   */
  activate(): void {}

  async health(): Promise<StorageHealth> {
    return { ok: true, kind: this.kind };
  }

  async close(): Promise<void> {}

  space(canvasId: string): SpaceFileScope {
    const safeId = sanitizeId(canvasId, 'canvasId');
    const root = path.join(this.#workspacePath, safeId);
    const assertActive = (): void => {
      if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
        throw new Error(
          `Space file scope for "${safeId}" belongs to an inactive workspace. Resolve a fresh scope after workspace activation.`,
        );
      }
    };
    return Object.freeze({
      canvasId: safeId,
      directory: (): string => {
        assertActive();
        return root;
      },
      nodesDirectory: (): string => {
        assertActive();
        return path.join(root, 'nodes');
      },
      nodeIdForPath: async (relativePath: string): Promise<string | null> => {
        assertActive();
        // The name *is* the address here, so the mapping needs no index —
        // and a file whose stem is not a usable id belongs to nothing.
        const stem = NODE_FILE_RE.exec(relativePath)?.[1];
        if (stem === undefined) return null;
        try {
          return sanitizeId(stem, 'nodeId');
        } catch {
          return null;
        }
      },
      registerHandleOwner: (owner: SpaceFileHandleOwner): (() => void) => {
        assertActive();
        return registerSpaceDirHandleOwner(safeId, owner);
      },
    });
  }

  async stageImport(canvasId: string): Promise<SpaceImportStaging> {
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
        // The destination is the id, so there is no name to allocate and no
        // title to adjust — the record survives the round trip untouched.
        await rename(stagingDirectory, path.join(this.#workspacePath, safeId));
        published = true;
        return record;
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
