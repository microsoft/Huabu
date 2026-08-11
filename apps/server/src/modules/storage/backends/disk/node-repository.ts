// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Disk implementation of the portable, read-only node repository. */

import { createHash } from 'node:crypto';
import path from 'node:path';

import { getWorkspacePath } from '../../../workspace.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type { NodeContent } from '../../../canvas/persistence-types.js';
import type {
  NodeRecordRevision,
  NodeRepository,
  NodeSnapshot,
} from '../../ports/structured.js';

/**
 * Recursively order object keys before hashing.
 *
 * Node records come from YAML and are JSON-shaped, but loader-owned
 * frontmatter fields may be nested. Sorting only the top level would make a
 * semantically identical record acquire a different revision when an adapter
 * returns nested keys in another order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;

  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) ordered[key] = canonicalize(item);
  }
  return ordered;
}

function revisionOf(
  record: NodeContent,
  logicalName: string,
  duplicateLogicalNames: readonly string[] | undefined,
): NodeRecordRevision {
  const canonical = JSON.stringify(
    canonicalize({ record, logicalName, duplicateLogicalNames }),
  );
  const digest = createHash('sha256')
    .update('huabu-node-record-v1\0')
    .update(canonical)
    .digest('base64url');
  return `nr1_${digest}` as NodeRecordRevision;
}

/**
 * Build the Disk node snapshot without performing IO.
 *
 * The aggregate commit adapter uses this inside its synchronous critical
 * section to verify preconditions and produce the exact same revision tokens
 * as {@link DiskNodeRepository}. It stays backend-private (this module is not
 * re-exported from the storage public entry point).
 */
export function diskNodeSnapshotOf(
  record: NodeContent,
  logicalName: string,
  duplicateLogicalNames?: readonly string[],
): NodeSnapshot {
  const duplicates =
    duplicateLogicalNames === undefined
      ? undefined
      : [...duplicateLogicalNames].sort();
  return {
    record,
    logicalName,
    revision: revisionOf(record, logicalName, duplicates),
    ...(duplicates === undefined ? {} : { duplicateLogicalNames: duplicates }),
  };
}

export class DiskNodeRepository implements NodeRepository {
  readonly #store: CanvasStore;
  readonly #workspacePath: string;

  constructor(store: CanvasStore) {
    this.#store = store;
    this.#workspacePath = path.resolve(getWorkspacePath());
  }

  async read(nodeId: string): Promise<NodeSnapshot | null> {
    this.#assertActiveWorkspace();
    this.#store.revalidateNodeForRead(nodeId);
    const record = await this.#store.readNodeAsync(nodeId);
    return record === null ? null : this.#snapshot(nodeId, record);
  }

  async readMany(
    nodeIds: readonly string[],
  ): Promise<ReadonlyMap<string, NodeSnapshot>> {
    this.#assertActiveWorkspace();
    const requested = new Set(nodeIds);
    if (requested.size === 0) return new Map();

    // The legacy batch reader is a bounded-concurrency, one-pass directory
    // scan and primes the id/name index used to assemble each snapshot.
    const records = await this.#store.readAllNodes();
    const snapshots = new Map<string, NodeSnapshot>();
    for (const nodeId of requested) {
      const record = records.get(nodeId);
      if (record !== undefined) {
        snapshots.set(nodeId, this.#snapshot(nodeId, record));
      }
    }
    return snapshots;
  }

  #assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        `NodeRepository(${this.#store.canvasId}) belongs to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }
  }

  #snapshot(nodeId: string, record: NodeContent): NodeSnapshot {
    const logicalName = this.#store.nodeLogicalName(nodeId);
    const duplicateLogicalNames = this.#store.isDuplicateNode(nodeId)
      ? this.#store.duplicateNodeFiles(nodeId)
      : undefined;
    return diskNodeSnapshotOf(record, logicalName, duplicateLogicalNames);
  }
}
