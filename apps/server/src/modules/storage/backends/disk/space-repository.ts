// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk ownership of the Space collection: membership, World identity, and
 * ordinary create/delete/rename.
 *
 * Both halves rescan the directory index before answering, so external
 * imports, deletes, and Finder renames are visible without an explicit cache
 * invalidation call — and so creation allocates around a Space that arrived
 * outside this process. The World rule is resolved in exactly one place here
 * (`#requireWorld`); when reads and lifecycle were separate ports it had to be
 * spelled out twice.
 */

import path from 'node:path';

import {
  isWorldCanvasId,
  listAllCanvasDirEntries,
  listCanvasDirEntries,
  refreshCanvasDirIndex,
  registerCanvasDir,
  requireWorldCanvasId,
  suggestCanvasDir,
} from './canvas-dirs.js';
import { canvasJsonPath, SPACE_JSON_FILENAME } from './layout.js';
import {
  forgetCanvasStore,
  getCanvasStore,
} from './legacy/canvas-store-cache.js';
import { withSpaceDirHandlesReleased } from './space-dir-handles.js';
import { readValidCanvasFile } from './space-record-validation.js';
import { readDiskSpaceRecord } from './space-record.js';
import {
  titleForAllocatedDirectory,
  titleVisibleAtDirectory,
} from './space-title.js';
import { ensureWorldCanvasOnDisk } from './world-canvas.js';
import { atomicWriteJson, mkdirp, sanitizeId } from '../../../../utils/fs.js';
import { normalizeForCompare } from '../../../../utils/naming.js';
import { getWorkspacePath } from '../../../workspace.js';
import {
  assertSpaceMutationAllowed,
  beginSpaceDeleteAdmission,
} from '../../space-lifecycle-admission.js';

import type { RenameSelfResult } from './legacy/canvas-store.js';
import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type {
  SpaceBeginDeleteResult,
  SpaceCreateInput,
  SpaceCreateResult,
  SpaceDeleteInput,
  SpaceDeleteSession,
  SpaceRenameInput,
  SpaceRenameResult,
  SpaceRepository,
} from '../../ports/structured.js';
import type { CanvasSummary } from '@huabu/shared';

type DiskRenameOperationResult =
  | Exclude<RenameSelfResult, { ok: true }>
  | { ok: true; record: CanvasFile };

export class DiskSpaceRepository implements SpaceRepository {
  readonly #workspacePath: string;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#workspacePath = path.resolve(getWorkspacePath());
    this.#now = now;
  }

  async list(): Promise<CanvasSummary[]> {
    this.#assertActiveWorkspace();
    refreshCanvasDirIndex();

    return listCanvasDirEntries().map((entry) => {
      return {
        canvasId: entry.id,
        title: titleVisibleAtDirectory(entry.title, entry.id, entry.filename),
        nodeCount: entry.nodeCount ?? 0,
        createdAt: entry.createdAt ?? 0,
        updatedAt: entry.updatedAt ?? 0,
      };
    });
  }

  async worldId(): Promise<string> {
    this.#assertActiveWorkspace();
    return this.#requireWorld();
  }

  /**
   * Bootstrap the World, delegating to the same idempotent Disk primitive
   * Workspace preparation calls.
   *
   * One writer for one file: the preparation path may still run before the
   * store is mounted (legacy migrations remain filesystem-based), so a second
   * implementation here would be a second authority over `.world/space.json`
   * that could disagree about what counts as established. The primitive
   * already reads an existing `.world` as established storage and raises on a
   * malformed one, which is exactly what the port promises.
   *
   * The directory index is refreshed afterwards because a freshly created
   * World is a new member of the collection every later read resolves through.
   */
  async ensureWorld(): Promise<string> {
    this.#assertActiveWorkspace();
    const canvasId = ensureWorldCanvasOnDisk(this.#workspacePath);
    refreshCanvasDirIndex();
    return canvasId;
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
    // Revalidate the protected World identity before a destructive session,
    // as the old composition path did before touching blobs.
    if (this.#isWorld(canvasId)) {
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
    if (this.#isWorld(canvasId)) {
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

  /**
   * The single World resolution point for this backend namespace.
   *
   * Always rescans first: every caller either reports World identity or is
   * about to refuse a destructive operation on it, and neither may act on a
   * cached id.
   *
   * `worldId()` reports the identity, so a missing World is an integrity
   * failure it must raise. The lifecycle guards only ask whether *this* Space
   * is the protected one, which a namespace without a World answers with a
   * plain no — the same answer `isWorldCanvasId` gave before Phase 4. Raising
   * there instead would turn every ordinary delete and rename in a workspace
   * whose World is missing or malformed into a 500.
   */
  #isWorld(canvasId: string): boolean {
    refreshCanvasDirIndex();
    return isWorldCanvasId(canvasId);
  }

  #requireWorld(): string {
    refreshCanvasDirIndex();
    return requireWorldCanvasId();
  }

  #assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        'Space repository belongs to an inactive workspace. ' +
          'Resolve a fresh Space repository after workspace activation.',
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
