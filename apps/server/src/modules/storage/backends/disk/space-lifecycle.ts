// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Disk ownership of ordinary Space creation and deletion. */

import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  forgetCanvasStore,
  getCanvasStore,
} from './legacy/canvas-store-cache.js';
import { readDiskSpaceRecord } from './space-repository.js';
import { atomicWriteJson, mkdirp, sanitizeId } from '../../../../utils/fs.js';
import {
  isWorldCanvasId,
  registerCanvasDir,
  suggestCanvasDir,
} from '../../../workspace/disk/canvas-dirs.js';
import { toSafeFilename } from '../../../workspace/disk/naming.js';
import {
  canvasJsonPath,
  SPACE_JSON_FILENAME,
} from '../../../workspace/disk/paths.js';
import { withSpaceDirHandlesReleased } from '../../../workspace/disk/space-dir-handles.js';
import { getWorkspacePath } from '../../../workspace.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type {
  SpaceCreateInput,
  SpaceCreateResult,
  SpaceDeleteInput,
  SpaceDeleteResult,
  SpaceLifecycleRepository,
  SpaceRenameInput,
  SpaceRenameResult,
} from '../../ports/structured.js';

function persistedTitle(
  requested: string | null,
  canvasId: string,
  directoryName: string,
): string | null {
  const base = toSafeFilename(requested, canvasId);
  if (directoryName === base) return requested;
  if (requested === null) return directoryName;
  return `${requested}${directoryName.slice(base.length)}`;
}

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
    if (existsSync(canvasJsonPath(canvasId))) {
      return { ok: false, reason: 'already-exists' };
    }

    // This method deliberately contains no `await`: same-process callers that
    // start together cannot both pass the existence check before one publishes
    // its record and index entry.
    const directoryName = suggestCanvasDir(input.title, canvasId);
    const directoryPath = path.join(this.#workspacePath, directoryName);
    mkdirp(directoryPath);

    const title = persistedTitle(input.title, canvasId, directoryName);
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

  async delete(input: SpaceDeleteInput): Promise<SpaceDeleteResult> {
    this.#assertActiveWorkspace();
    const canvasId = sanitizeId(input.canvasId, 'canvasId');
    if (isWorldCanvasId(canvasId)) {
      return { ok: false, reason: 'world-forbidden' };
    }

    const store = getCanvasStore(canvasId);
    const deleted = await withSpaceDirHandlesReleased(canvasId, () =>
      store.destroy(),
    );
    forgetCanvasStore(canvasId);
    return deleted
      ? { ok: true, reason: 'deleted' }
      : { ok: false, reason: 'not-found' };
  }

  async rename(input: SpaceRenameInput): Promise<SpaceRenameResult> {
    this.#assertActiveWorkspace();
    const canvasId = sanitizeId(input.canvasId, 'canvasId');
    const store = getCanvasStore(canvasId);
    const renamed = await withSpaceDirHandlesReleased(canvasId, () =>
      store.renameSelf(input.title),
    );
    if (!renamed.ok) {
      switch (renamed.reason) {
        case 'not-found':
          return { ok: false, reason: 'not-found' };
        case 'forbidden':
          return { ok: false, reason: 'world-forbidden' };
        case 'conflict':
          return { ok: false, reason: 'title-conflict' };
        case 'fs-error':
          throw new Error(
            `Could not rename Space ${JSON.stringify(canvasId)}: ${renamed.message}`,
          );
      }
    }

    const record = readDiskSpaceRecord(store);
    if (record === null) {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: true, record };
  }

  #assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        'Space lifecycle repository belongs to an inactive workspace. ' +
          'Resolve a fresh lifecycle repository after workspace activation.',
      );
    }
  }
}
