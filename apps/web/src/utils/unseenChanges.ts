// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Which nodes an Agent created or changed that the person has not touched
 * since. The source is the per-conversation change-review records, the same
 * ones the change card lists; nothing else is recorded for the marks.
 */

import type { SeenChanges } from '@huabu/shared';
import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

/** What one conversation's Agent did to a node. */
export interface UnseenSource {
  threadId: string;
  /** `create` when the Agent made the node, `update` when it changed it. */
  kind: 'create' | 'update';
  /**
   * The state of this conversation's review of the node. Recorded as seen,
   * it stays so until the conversation changes the node again.
   */
  key: string;
}

/** A node's mark: every conversation whose unseen change touches it. */
export interface UnseenMark {
  sources: UnseenSource[];
}

/**
 * Identity of one state of a record. A record keeps its id when a later
 * change to the same node is folded into it, so the fingerprint is part of
 * the key: a node changed again after being seen is unseen again.
 */
export function seenKey(record: CanvasChangeRecord): string {
  return `${record.id}@${record.appliedFingerprint ?? ''}`;
}

/** Whether a record is one the canvas marks: a node made or changed. */
function marks(record: CanvasChangeRecord): record is CanvasChangeRecord & {
  nodeId: string;
  kind: 'create' | 'update';
} {
  if (!record.nodeId) return false;
  if (record.kind === 'create') return true;
  // An update that changed no data field only moved or resized the node.
  return record.kind === 'update' && (record.fingerprintKeys?.length ?? 0) > 0;
}

/**
 * The unseen mark of each node, by node id.
 *
 * @param seen What the person has seen: conversation → node → the state of
 *   that conversation's review of the node when they saw it.
 */
export function unseenMarks(
  byThread: Readonly<Record<string, readonly CanvasChangeRecord[]>>,
  seen: SeenChanges,
): Map<string, UnseenMark> {
  const result = new Map<string, UnseenMark>();
  for (const [threadId, records] of Object.entries(byThread)) {
    // One state per node: a conversation usually holds one record for a node,
    // and when it holds more, all of them make up what there is to see.
    const nodes = new Map<
      string,
      { kind: 'create' | 'update'; keys: string[] }
    >();
    for (const record of records) {
      if (!marks(record)) continue;
      const node = nodes.get(record.nodeId) ?? { kind: record.kind, keys: [] };
      nodes.set(record.nodeId, node);
      node.keys.push(seenKey(record));
      // A node the conversation made stays `create` however it changed it.
      if (record.kind === 'create') node.kind = 'create';
    }
    for (const [nodeId, { kind, keys }] of nodes) {
      const key = keys.sort().join('|');
      if (seen[threadId]?.[nodeId] === key) continue;
      const mark = result.get(nodeId) ?? { sources: [] };
      result.set(nodeId, mark);
      mark.sources.push({ threadId, kind, key });
    }
  }
  return result;
}

/** Whether a mark holds a change of the given conversation. */
export function markTouches(mark: UnseenMark, threadId: string): boolean {
  return mark.sources.some((source) => source.threadId === threadId);
}
