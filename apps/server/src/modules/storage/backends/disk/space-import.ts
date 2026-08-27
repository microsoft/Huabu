// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk bundle publication — where an imported Space lands.
 *
 * The route owns the `.huabu.zip` format: unzipping it, reading its manifest,
 * remapping artifact URLs. That is a *public* format, and §12.6.2 explicitly
 * lets a consumer interpret one. What it must not own is where the result goes
 * on the active backend — the staging location that the Space scan is
 * guaranteed to ignore, the title-derived directory name, the record filename,
 * and the directory index entry. All four are this backend's layout, so they
 * live here (proposal §12.5.2).
 *
 * Disk-only by construction, reached through `space(canvasId).diskTree`'s
 * sibling on the barrel, and declared as `space-bundle-import` in the
 * capability matrix.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  refreshCanvasDirIndex,
  registerCanvasDir,
  suggestCanvasDir,
} from './canvas-dirs.js';
import { SPACE_JSON_FILENAME } from './layout.js';
import { toSafeFilename } from '../../../../utils/naming.js';
import { getWorkspacePath } from '../../../workspace.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';

/**
 * The filenames a bundle may carry its record under, before this backend
 * existed to disagree.
 *
 * Historically the same name Disk uses, and deliberately *not* the same
 * constant: one is a wire format frozen by every bundle already exported, the
 * other is how a backend files a record today. They drift the moment a backend
 * that is not Disk exports one.
 *
 * Assembled per call rather than captured at module scope. `layout.ts` and
 * this file sit in one import cycle — layout imports `getWorkspacePath`,
 * `workspace.ts` imports the storage barrel, and the composition root imports
 * this module — so a graph entered through a Disk module evaluates this file
 * while `layout.ts` is still initializing. A module-level array would freeze
 * `undefined` in place of the record filename for the life of the process.
 */
function bundleRecordFilenames(): readonly string[] {
  return [SPACE_JSON_FILENAME, 'canvas.json'];
}

export interface DiskSpaceImport {
  /** Where the bundle's entries should be written. */
  readonly stagingDirectory: string;
  /** The record the bundle carried, or null when it has none. */
  readRecord(): Promise<CanvasFile | null>;
  /**
   * Install the staged directory as a Space, returning the title actually
   * allocated — which may carry a de-duplication suffix the caller did not
   * ask for.
   */
  publish(record: CanvasFile): Promise<{ title: string | null }>;
  /** Remove the staging directory. Idempotent. */
  discard(): Promise<void>;
}

/**
 * Open a staging area for one imported Space.
 *
 * The directory is hidden so `scanWorkspace()` skips it: an unpublished
 * import must not be visible as a Space, and must not be picked up by the
 * record reader's self-heal as one titled after its own directory.
 */
export function stageDiskSpaceImport(canvasId: string): DiskSpaceImport {
  const stagingDirectory = path.join(getWorkspacePath(), `.import-${canvasId}`);

  return {
    stagingDirectory,

    async readRecord(): Promise<CanvasFile | null> {
      for (const name of bundleRecordFilenames()) {
        const candidate = path.join(stagingDirectory, name);
        if (!existsSync(candidate)) continue;
        return JSON.parse(await readFile(candidate, 'utf8')) as CanvasFile;
      }
      return null;
    },

    async publish(record: CanvasFile): Promise<{ title: string | null }> {
      const requestedTitle = record.title;
      const directoryName = suggestCanvasDir(requestedTitle, canvasId);
      // `suggestCanvasDir` may append a de-duplication suffix. Carry it into
      // the title so the name a user sees and the directory agree — otherwise
      // the record reader's self-heal rewrites the title on first read.
      const safeFromTitle = toSafeFilename(requestedTitle, canvasId);
      const suffix =
        directoryName === safeFromTitle
          ? ''
          : directoryName.slice(safeFromTitle.length);
      const title =
        suffix === '' || requestedTitle === null
          ? requestedTitle
          : requestedTitle + suffix;

      // Written under this backend's name, whatever the bundle called it, and
      // any other spelling removed so two records cannot disagree.
      await writeFile(
        path.join(stagingDirectory, SPACE_JSON_FILENAME),
        JSON.stringify({ ...record, canvasId, title }),
      );
      for (const name of bundleRecordFilenames()) {
        if (name === SPACE_JSON_FILENAME) continue;
        await rm(path.join(stagingDirectory, name), { force: true });
      }

      await mkdir(path.dirname(stagingDirectory), { recursive: true });
      await rename(
        stagingDirectory,
        path.join(getWorkspacePath(), directoryName),
      );
      registerCanvasDir(canvasId, directoryName, title);
      refreshCanvasDirIndex();
      return { title };
    },

    async discard(): Promise<void> {
      await rm(stagingDirectory, { recursive: true, force: true });
    },
  };
}
