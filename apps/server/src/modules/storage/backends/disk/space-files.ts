// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Title-addressed Disk materialization of the Space file capability.
 *
 * A Space lives at `<workspace>/<safe(title)>/`, which is the layout a user
 * sees in Finder and renames from. Resolving that directory means asking the
 * structured records which title a Space currently has, so this
 * implementation is only coherent beside the Disk structured backend — see
 * `AddressedSpaceFiles` for the materialization that composes with any of
 * them, and `profile.ts` for the rule that keeps the pairing honest.
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
import { registerSpaceDirHandleOwner } from './space-dir-handles.js';
import { sanitizeId } from '../../../../utils/fs.js';
import { toSafeFilename } from '../../../../utils/naming.js';
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
const NODE_FILE_RE = /^nodes\/([^/]+\.md)$/;

export class DiskSpaceFiles implements SpaceFiles {
  readonly kind = 'disk-titled' as const;
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

  async init(): Promise<void> {}

  activate(): void {
    refreshCanvasDirIndex();
  }

  async health(): Promise<StorageHealth> {
    return { ok: true, kind: this.kind };
  }

  async close(): Promise<void> {}

  space(canvasId: string): SpaceFileScope {
    const safeId = sanitizeId(canvasId, 'canvasId');
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
        // The sidecar index is the Disk authority for this mapping: a node
        // is filed under its label, so the name alone cannot be inverted.
        return getCanvasStore(safeId).nodeIdForFilename(filename);
      },
      registerHandleOwner: (owner: SpaceFileHandleOwner): (() => void) => {
        assertActive();
        return registerSpaceDirHandleOwner(safeId, owner);
      },
    });
  }

  async stageImport(canvasId: string): Promise<SpaceImportStaging> {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error('Cannot stage an import for an inactive Workspace');
    }
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
        if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
          throw new Error('Cannot publish into an inactive Workspace');
        }
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
}
