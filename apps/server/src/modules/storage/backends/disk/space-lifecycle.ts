// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Disk ownership of ordinary Space creation and deletion. */

import path from 'node:path';

import {
  forgetCanvasStore,
  getCanvasStore,
} from './legacy/canvas-store-cache.js';
import { readValidCanvasFile } from './space-record-validation.js';
import { readDiskSpaceRecord } from './space-repository.js';
import {
  titleForAllocatedDirectory,
  titleVisibleAtDirectory,
} from './space-title.js';
import { atomicWriteJson, mkdirp, sanitizeId } from '../../../../utils/fs.js';
import {
  listAllCanvasDirEntries,
  refreshCanvasDirIndex,
  registerCanvasDir,
  requireWorldCanvasId,
  suggestCanvasDir,
} from '../../../workspace/disk/canvas-dirs.js';
import { normalizeForCompare } from '../../../workspace/disk/naming.js';
import {
  canvasJsonPath,
  SPACE_JSON_FILENAME,
} from '../../../workspace/disk/paths.js';
import { withSpaceDirHandlesReleased } from '../../../workspace/disk/space-dir-handles.js';
import { getWorkspacePath } from '../../../workspace.js';
import {
  assertSpaceMutationAllowed,
  beginSpaceDeleteAdmission,
} from '../../space-lifecycle-admission.js';

import type { RenameSelfResult } from './legacy/canvas-store.js';
import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type {
  SpaceCreateInput,
  SpaceCreateResult,
  SpaceDeleteSession,
  SpaceBeginDeleteResult,
  SpaceDeleteInput,
  SpaceLifecycleRepository,
  SpaceRenameInput,
  SpaceRenameResult,
} from '../../ports/structured.js';

type DiskRenameOperationResult =
  | Exclude<RenameSelfResult, { ok: true }>
  | { ok: true; record: CanvasFile };

export class DiskSpaceLifecycleRepository implements SpaceLifecycleRepository {
  readonly #workspacePath: string;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#workspacePath = path.resolve(getWorkspacePath());
    this.#now = now;
  }

  async create(input: SpaceCreateInput): Promise<SpaceCreateResult> {
    this.#assertActiveWorkspace();
    const canvasId = sanitizeId(input.canvasId, 'canvasId');
    assertSpaceMutationAllowed(this.#workspacePath, canvasId);
    // Creation owns membership allocation. Refresh here rather than relying
    // on a caller having listed first: an externally imported Space must
    // participate in both stable-id and directory-name collision checks.
    refreshCanvasDirIndex();
    if (listAllCanvasDirEntries().some((entry) => entry.id === canvasId)) {
      return { ok: false, reason: 'already-exists' };
    }

    // This method deliberately contains no `await`: same-process callers that
    // start together cannot both pass the existence check before one publishes
    // its record and index entry.
    const directoryName = suggestCanvasDir(input.title, canvasId);
    const directoryPath = path.join(this.#workspacePath, directoryName);
    mkdirp(directoryPath);

    const title = titleForAllocatedDirectory(
      input.title,
      canvasId,
      directoryName,
    );
    const timestamp = this.#now();
    const record: CanvasFile = {
      canvasId,
      title,
      version: 0,
      state: { nodes: [], edges: [] },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    atomicWriteJson(path.join(directoryPath, SPACE_JSON_FILENAME), record);
    registerCanvasDir(canvasId, directoryName, title);
    return { ok: true, record };
  }

  async beginDelete(input: SpaceDeleteInput): Promise<SpaceBeginDeleteResult> {
    this.#assertActiveWorkspace();
    const canvasId = sanitizeId(input.canvasId, 'canvasId');
    // Revalidate the protected World identity before a destructive session.
    // The old composition path also refreshed this invariant before touching
    // blobs, so a stale or malformed World fails closed.
    refreshCanvasDirIndex();
    if (requireWorldCanvasId() === canvasId) {
      return { ok: false, reason: 'world-forbidden' };
    }

    const store = getCanvasStore(canvasId);
    const release = await beginSpaceDeleteAdmission(
      this.#workspacePath,
      canvasId,
    );
    let state: 'open' | 'finishing' | 'closed' = 'open';
    const close = (): void => {
      if (state === 'closed') return;
      state = 'closed';
      release();
    };
    const session: SpaceDeleteSession = Object.freeze({
      finish: async () => {
        if (state !== 'open') {
          throw new Error(`Space deletion session for ${canvasId} is closed`);
        }
        state = 'finishing';
        try {
          const deleted = await withSpaceDirHandlesReleased(canvasId, () =>
            store.destroy(),
          );
          forgetCanvasStore(canvasId);
          return deleted
            ? { ok: true as const, reason: 'deleted' as const }
            : { ok: false as const, reason: 'not-found' as const };
        } finally {
          close();
        }
      },
      abort: async () => {
        if (state === 'finishing') {
          throw new Error(
            `Space deletion session for ${canvasId} is already finishing`,
          );
        }
        close();
      },
    });
    return { ok: true, session };
  }

  async rename(input: SpaceRenameInput): Promise<SpaceRenameResult> {
    this.#assertActiveWorkspace();
    const canvasId = sanitizeId(input.canvasId, 'canvasId');
    assertSpaceMutationAllowed(this.#workspacePath, canvasId);
    refreshCanvasDirIndex();
    if (requireWorldCanvasId() === canvasId) {
      return { ok: false, reason: 'world-forbidden' };
    }
    const store = getCanvasStore(canvasId);
    const current = readDiskSpaceRecord(store);
    if (current === null) return { ok: false, reason: 'not-found' };
    if (current.title === input.title) return { ok: true, record: current };
    const renamed = await withSpaceDirHandlesReleased(
      canvasId,
      (): DiskRenameOperationResult => {
        const renamed = store.renameSelf(input.title);
        if (!renamed.ok) return renamed;

        const record = readValidCanvasFile(canvasJsonPath(canvasId), canvasId);
        if (record === null) {
          return { ok: false, reason: 'not-found' };
        }
        const renamedRecord = { ...record, title: input.title };
        store.write(renamedRecord);
        return { ok: true, record: renamedRecord };
      },
    );
    if (!renamed.ok) {
      switch (renamed.reason) {
        case 'not-found':
          return { ok: false, reason: 'not-found' };
        case 'forbidden':
          return { ok: false, reason: 'world-forbidden' };
        case 'conflict':
          return {
            ok: false,
            reason: 'title-conflict',
            conflictingTitle: this.#conflictingTitle(renamed.conflictWith),
          };
        case 'fs-error':
          throw new Error(
            `Could not rename Space ${JSON.stringify(canvasId)}: ${renamed.message}`,
          );
      }
    }
    return renamed;
  }

  #assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        'Space lifecycle repository belongs to an inactive workspace. ' +
          'Resolve a fresh lifecycle repository after workspace activation.',
      );
    }
  }

  #conflictingTitle(directoryName: string): string | null {
    const entry = listAllCanvasDirEntries().find(
      (candidate) =>
        normalizeForCompare(candidate.filename) ===
        normalizeForCompare(directoryName),
    );
    return entry
      ? titleVisibleAtDirectory(entry.title, entry.id, entry.filename)
      : directoryName;
  }
}
