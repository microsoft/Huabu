// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Disk implementation of the asynchronous node-record port. */

import { createHash } from 'node:crypto';
import path from 'node:path';

import { getWorkspacePath } from '../../../workspace.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type { NodeContent } from '../../../canvas/persistence-types.js';
import type {
  NodeChangePosition,
  NodeChanges,
  NodeDeleteResult,
  NodePutInput,
  NodePutResult,
  NodeSnapshot,
  NodeStreamOptions,
  SpaceNodes,
} from '../../ports/structured.js';

/** Opaque full-record token; public content revisions remain a Canvas concern. */
function revisionOf(record: NodeContent | null): string | null {
  if (record === null) return null;
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function snapshotOf(record: NodeContent): NodeSnapshot {
  const revision = revisionOf(record);
  if (revision === null) throw new Error('A persisted node must have a token');
  return { record, revision };
}

function snapshotsOf(
  contents: ReadonlyMap<string, NodeContent>,
): Map<string, NodeSnapshot> {
  const out = new Map<string, NodeSnapshot>();
  for (const [nodeId, record] of contents) out.set(nodeId, snapshotOf(record));
  return out;
}

/**
 * The one sequence a Disk Space has: its sidecars' modification times in
 * whole milliseconds. They are properties of the files, so they are the
 * same after a restart and for any process reading the directory.
 */
const DISK_CHANGE_EPOCH = 'disk:mtime-ms';

/**
 * How far behind the clock a position taken from the clock is placed. A file
 * system stamps a write with a time that can be earlier than the clock read
 * just before it: the kernel's file clock ticks a few milliseconds apart, and
 * some volumes keep whole seconds or two-second steps.
 */
const DISK_CLOCK_SLACK_MS = 2_000;

export class DiskSpaceNodes implements SpaceNodes {
  readonly canvasId: string;

  readonly #store: CanvasStore;
  readonly #workspacePath: string;

  constructor(store: CanvasStore) {
    this.#store = store;
    this.canvasId = store.canvasId;
    this.#workspacePath = path.resolve(getWorkspacePath());
  }

  async read(nodeId: string): Promise<NodeSnapshot | null> {
    this.#assertActiveWorkspace();
    const record = this.#store.readNodeStrict(nodeId);
    return record === null ? null : snapshotOf(record);
  }

  /**
   * Named nodes only.
   *
   * Resolved one id at a time through the same strict read {@link read} uses,
   * so a selection sees exactly what reading each id would — including the
   * index rebuild that resolves an externally renamed sidecar. Disk pays one
   * directory scan to warm the id index and then one file read per requested
   * id, which is the cost this member exists to keep proportional. Duplicate
   * ids in the request collapse, as they do in the returned map.
   */
  async readMany(
    nodeIds: readonly string[],
  ): Promise<Map<string, NodeSnapshot>> {
    this.#assertActiveWorkspace();
    const out = new Map<string, NodeSnapshot>();
    for (const nodeId of new Set(nodeIds)) {
      const record = this.#store.readNodeStrict(nodeId);
      if (record !== null) out.set(nodeId, snapshotOf(record));
    }
    return out;
  }

  /**
   * Every node, under the same reachability rule {@link read} applies.
   *
   * The scan is strict about reachability and lenient about content, so it
   * answers about exactly the nodes a per-id read would: an unreadable
   * sidecar rejects here instead of being dropped from the collection, while
   * a sidecar whose frontmatter a user broke by hand is recovered rather than
   * refused. A lenient scan would leave the port claiming that environmental
   * failures reject while its two collection shapes reported absence.
   */
  async list(): Promise<Map<string, NodeSnapshot>> {
    this.#assertActiveWorkspace();
    return snapshotsOf(
      await this.#store.readAllNodes({ strict: true, strictRecords: false }),
    );
  }

  /** {@link list}, delivered as each sidecar lands, with the same strictness. */
  async stream(
    onNode: (snapshot: NodeSnapshot) => void,
    options?: NodeStreamOptions,
  ): Promise<Map<string, NodeSnapshot>> {
    this.#assertActiveWorkspace();
    const contents = await this.#store.streamAllNodes(
      (_id, content) => onNode(snapshotOf(content)),
      options?.signal,
      { strict: true, strictRecords: false },
    );
    return snapshotsOf(contents);
  }

  async put(input: NodePutInput): Promise<NodePutResult> {
    this.#assertActiveWorkspace();
    if (input.record.nodeId !== input.nodeId) {
      throw new Error(
        `SpaceNodes(${this.canvasId}) nodeId mismatch: ` +
          `argument=${JSON.stringify(input.nodeId)} ` +
          `record=${JSON.stringify(input.record.nodeId)}`,
      );
    }

    // Keep the anti-resurrection guard ahead of both the read/CAS and the
    // write. A late request targeting a deleted node is suppressed even when
    // it retained an otherwise-current revision.
    if (this.#store.isNodeWriteSuppressed(input.nodeId)) {
      return { ok: false, reason: 'write-suppressed' };
    }

    const current = this.#store.readNodeStrict(input.nodeId);
    const currentRevision = revisionOf(current);
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== currentRevision
    ) {
      return {
        ok: false,
        reason: 'revision-conflict',
        currentRevision,
      };
    }

    // No `await` occurs between the revision check and the synchronous Disk
    // write. That preserves the existing single-process CAS critical section.
    const result = this.#store.writeNode(input.nodeId, input.record, {
      strictRename: input.strictLabel,
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'not-found':
          return { ok: false, reason: 'not-found' };
        case 'conflict': {
          const conflicting = this.#store.readNodeStrict(
            result.conflictWith.id,
          );
          return {
            ok: false,
            reason: 'label-conflict',
            conflictingNodeId: result.conflictWith.id,
            conflictingLabel:
              conflicting?.label ??
              result.conflictWith.filename.replace(/\.md$/, ''),
          };
        }
        case 'duplicate':
          return {
            ok: false,
            reason: 'duplicate-node',
            names: result.files,
          };
      }
    }

    // CanvasStore may de-duplicate the requested label. Re-read rather than
    // reconstructing so the success value is the exact persisted record and
    // its matching revision.
    const persisted = this.#store.readNode(input.nodeId);
    if (persisted === null) {
      throw new Error(
        `SpaceNodes(${this.canvasId}) wrote node ${JSON.stringify(input.nodeId)} but could not read it back`,
      );
    }
    return { ok: true, ...snapshotOf(persisted) };
  }

  async delete(nodeId: string): Promise<NodeDeleteResult> {
    this.#assertActiveWorkspace();
    return this.#store.deleteNode(nodeId);
  }

  /**
   * Sidecars modified at or after `since`.
   *
   * The position is the latest modification time among the sidecars, but
   * never later than the clock less {@link DISK_CLOCK_SLACK_MS}. "At or after" covers a file system whose
   * times are coarser than the gap between two writes: a write in the same
   * tick as the position is named (again) rather than missed. The clock
   * bound covers a sidecar dated in the future — copied in from a machine
   * whose clock runs ahead, say — which would otherwise put the position
   * beyond every write made until that date, and a clock that was set back:
   * the position then follows the clock down. Such a sidecar is simply named
   * on every call until the clock passes it. The slack is there because that
   * bound is the one place the clock is compared with file times: a write
   * made right after it can be stamped slightly earlier than the clock read.
   *
   * What it cannot see is a write dated before the position: a clock set
   * back past the Space's most recent write and not yet caught up, or a file
   * put in place with an older modification time kept (`cp -p`, a sync
   * client restoring one). The latter is an external edit and is the
   * external watcher's to report.
   *
   * Cost: one `stat` per sidecar, synchronous; no file is read once the id
   * index is warm.
   */
  async changes(since?: NodeChangePosition): Promise<NodeChanges> {
    this.#assertActiveWorkspace();
    const times = this.#store.nodeWriteTimes();
    let latest = 0;
    for (const time of times.values()) latest = Math.max(latest, time);
    const position = {
      epoch: DISK_CHANGE_EPOCH,
      seq: Math.min(latest, Date.now() - DISK_CLOCK_SLACK_MS),
    };
    if (
      since === undefined ||
      since.epoch !== DISK_CHANGE_EPOCH ||
      !Number.isFinite(since.seq)
    )
      return { position, nodeIds: null };
    const nodeIds: string[] = [];
    for (const [nodeId, time] of times) {
      if (time >= since.seq) nodeIds.push(nodeId);
    }
    return { position, nodeIds };
  }

  #assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        `SpaceNodes(${this.canvasId}) belongs to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }
  }
}
