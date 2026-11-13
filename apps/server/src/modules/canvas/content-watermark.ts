// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Which nodes had their content saved, and when, so a page whose Canvas
 * Sync stream was down can ask what it missed.
 *
 * A node-content save (body, title, summary, …) does not change the Space
 * version, and it reaches other pages only as an `invalidate` event naming
 * the node. A page that was not connected when the event was sent has no
 * way to learn of it from the version alone.
 *
 * Every such event is given the next value of one process-wide sequence.
 * Per Space the latest sequence of each node is remembered. A page tells
 * the server the last sequence it saw; the answer is the nodes saved after
 * it, or "unknown" when the memory does not reach back that far:
 *
 * - the server restarted (`epoch` differs) — the memory is not persisted;
 * - more than {@link MAX_NODES_PER_SPACE} distinct nodes of the Space, or
 *   {@link MAX_SPACES} Spaces, were saved since.
 *
 * Cost: one map write per content save; an answer walks the Space's
 * remembered nodes (at most {@link MAX_NODES_PER_SPACE}). Nothing is read
 * from storage. Memory is bounded by the two limits.
 */

import { randomUUID } from 'node:crypto';

/** Identifies this server process's sequence. */
const EPOCH = randomUUID();

const MAX_NODES_PER_SPACE = 512;
const MAX_SPACES = 256;

interface SpaceLog {
  /** Saves at or before this sequence are no longer all remembered. */
  floor: number;
  /** Node id → sequence of its latest save, oldest save first. */
  nodes: Map<string, number>;
}

let sequence = 0;
/** The highest sequence any forgotten Space log had reached. */
let forgottenUpTo = 0;
/** Least recently written first. */
const logs = new Map<string, SpaceLog>();

export interface ContentWatermark {
  epoch: string;
  seq: number;
}

/** Where the sequence stands; a page keeps it to ask from later. */
export function contentWatermark(): ContentWatermark {
  return { epoch: EPOCH, seq: sequence };
}

/**
 * Record a content save of `nodeIds` in `canvasId`.
 *
 * @returns The sequence given to the save.
 */
export function recordContentSave(
  canvasId: string,
  nodeIds: readonly string[],
): number {
  sequence += 1;
  let log = logs.get(canvasId);
  if (log) logs.delete(canvasId);
  else log = { floor: forgottenUpTo, nodes: new Map() };
  logs.set(canvasId, log);
  for (const nodeId of nodeIds) {
    log.nodes.delete(nodeId);
    log.nodes.set(nodeId, sequence);
  }
  while (log.nodes.size > MAX_NODES_PER_SPACE) {
    const [oldestId, oldestSeq] = log.nodes.entries().next().value as [
      string,
      number,
    ];
    log.nodes.delete(oldestId);
    log.floor = Math.max(log.floor, oldestSeq);
  }
  while (logs.size > MAX_SPACES) {
    const [oldestSpace] = logs.keys();
    logs.delete(oldestSpace);
    // The dropped log may have held saves up to the previous sequence.
    forgottenUpTo = sequence - 1;
  }
  return sequence;
}

/**
 * The nodes of `canvasId` whose content was saved after `since`, or `null`
 * when that cannot be told.
 */
export function contentSavedSince(
  canvasId: string,
  since: ContentWatermark,
): string[] | null {
  if (since.epoch !== EPOCH || since.seq > sequence) return null;
  const log = logs.get(canvasId);
  if (since.seq < (log?.floor ?? forgottenUpTo)) return null;
  if (!log) return [];
  const saved: string[] = [];
  for (const [nodeId, seq] of log.nodes) {
    if (seq > since.seq) saved.push(nodeId);
  }
  return saved;
}

/** Forget everything. For test isolation. */
export function resetContentWatermarkForTests(): void {
  sequence = 0;
  forgottenUpTo = 0;
  logs.clear();
}
