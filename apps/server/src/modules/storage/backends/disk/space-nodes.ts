// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Disk implementation of the asynchronous node-record port. */

import { createHash } from 'node:crypto';

import type { CanvasStore } from './legacy/canvas-store.js';
import type { NodeContent } from '../../../canvas/persistence-types.js';
import type {
  NodeDeleteResult,
  NodePutInput,
  NodePutResult,
  NodeSnapshot,
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

export class DiskSpaceNodes implements SpaceNodes {
  readonly canvasId: string;

  readonly #store: CanvasStore;

  constructor(store: CanvasStore) {
    this.#store = store;
    this.canvasId = store.canvasId;
  }

  async read(nodeId: string): Promise<NodeSnapshot | null> {
    const record = this.#store.readNodeStrict(nodeId);
    return record === null ? null : snapshotOf(record);
  }

  async put(input: NodePutInput): Promise<NodePutResult> {
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
    return this.#store.deleteNode(nodeId);
  }
}
