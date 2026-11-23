// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Which nodes an Agent created or changed that the person has not touched
 * since. The source is the per-conversation change-review records, the same
 * ones the change card lists; nothing else is recorded for the marks.
 */

import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

/** What one conversation's Agent did to a node. */
export interface UnseenSource {
  threadId: string;
  /** `create` when the Agent made the node, `update` when it changed it. */
  kind: 'create' | 'update';
  /** The {@link seenKey}s that mark this conversation's part seen. */
  keys: string[];
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

/** The unseen mark of each node, by node id. */
export function unseenMarks(
  byThread: Readonly<Record<string, readonly CanvasChangeRecord[]>>,
  seen: Readonly<Record<string, readonly string[]>>,
): Map<string, UnseenMark> {
  const result = new Map<string, UnseenMark>();
  for (const [threadId, records] of Object.entries(byThread)) {
    const seenHere = seen[threadId] ?? [];
    for (const record of records) {
      if (!marks(record)) continue;
      const key = seenKey(record);
      if (seenHere.includes(key)) continue;
      const mark = result.get(record.nodeId) ?? { sources: [] };
      result.set(record.nodeId, mark);
      const source = mark.sources.find((entry) => entry.threadId === threadId);
      if (!source)
        mark.sources.push({ threadId, kind: record.kind, keys: [key] });
      else {
        source.keys.push(key);
        // A node the conversation made stays `create` however it changed it.
        if (record.kind === 'create') source.kind = 'create';
      }
    }
  }
  return result;
}

/** Whether a mark holds a change of the given conversation. */
export function markTouches(mark: UnseenMark, threadId: string): boolean {
  return mark.sources.some((source) => source.threadId === threadId);
}

/** Every key a thread's records could be seen under, marked or not. */
export function threadSeenKeys(
  records: readonly CanvasChangeRecord[] | undefined,
): string[] {
  return (records ?? []).filter(marks).map(seenKey);
}
