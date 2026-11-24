// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  decodeNodeRecord,
  requireRevision,
  validateNodeContent,
} from './codecs.js';
import { sanitizeId } from '../../../../utils/fs.js';

import type {
  NodeChangePosition,
  NodePutInput,
  NodePutResult,
  NodeSnapshot,
} from '../../ports/structured.js';

export interface NodeRow {
  readonly record: NodeSnapshot['record'];
  readonly revision: string;
  readonly collisionKey: string;
}

export function decodeNodeRow(value: unknown, nodeId: string): NodeRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntaxError(`Malformed persisted Node ${JSON.stringify(nodeId)}`);
  }
  const row = value as Record<string, unknown>;
  const collisionKey = row['label_collision_key'];
  if (typeof collisionKey !== 'string') {
    throw new SyntaxError(
      `Invalid collision key for Node ${JSON.stringify(nodeId)}`,
    );
  }
  return {
    record: decodeNodeRecord(row['record_json'], nodeId),
    revision: requireRevision(row['revision'], nodeId),
    collisionKey,
  };
}

export function decodeIdentifiedNodeRow(
  value: unknown,
): [string, NodeSnapshot] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntaxError('Malformed persisted SQLite Node row');
  }
  const nodeId = (value as Record<string, unknown>)['node_id'];
  if (typeof nodeId !== 'string') {
    throw new SyntaxError('Invalid node_id in persisted SQLite Node');
  }
  const row = decodeNodeRow(value, nodeId);
  return [nodeId, { record: row.record, revision: row.revision }];
}

export function collectNodeRow(
  value: unknown,
  into: Map<string, NodeSnapshot>,
): void {
  const [nodeId, snapshot] = decodeIdentifiedNodeRow(value);
  into.set(nodeId, snapshot);
}

export function validatePut(input: NodePutInput): string {
  const nodeId = sanitizeId(input.nodeId, 'nodeId');
  validateNodeContent(input.record, nodeId);
  if (
    input.expectedRevision !== undefined &&
    input.expectedRevision !== null &&
    typeof input.expectedRevision !== 'string'
  ) {
    throw new TypeError('expectedRevision must be a string, null, or omitted');
  }
  return nodeId;
}

export function decodeLabelConflict(
  row: Record<string, unknown>,
): Extract<NodePutResult, { reason: 'label-conflict' }> {
  const conflictingNodeId = row['node_id'];
  const collisionKey = row['label_collision_key'];
  if (typeof conflictingNodeId !== 'string') {
    throw new SyntaxError('Invalid conflicting Node id');
  }
  const conflicting = decodeNodeRecord(row['record_json'], conflictingNodeId);
  return {
    ok: false,
    reason: 'label-conflict',
    conflictingNodeId,
    conflictingLabel:
      typeof conflicting.label === 'string'
        ? conflicting.label
        : typeof collisionKey === 'string'
          ? collisionKey
          : conflictingNodeId,
  };
}

/**
 * The sequence of node writes of one Space row.
 *
 * The creation time is part of the name so a Space deleted and created again
 * under the same id — whose counter starts over — is a different sequence.
 */
export function nodeChangeEpoch(
  kind: 'sqlite' | 'postgres',
  createdAt: unknown,
): string {
  return `${kind}:${String(createdAt)}`;
}

/** The position a Space that does not exist reports. */
export function absentNodeChangePosition(
  kind: 'sqlite' | 'postgres',
): NodeChangePosition {
  return { epoch: `${kind}:absent`, seq: 0 };
}

/**
 * Whether `since` can be compared with a Space's counter: the same sequence,
 * and not ahead of it.
 */
export function isComparableNodeChangePosition(
  since: NodeChangePosition | undefined,
  current: NodeChangePosition,
): since is NodeChangePosition {
  return (
    since !== undefined &&
    since.epoch === current.epoch &&
    Number.isSafeInteger(since.seq) &&
    since.seq >= 0 &&
    since.seq <= current.seq
  );
}

/** A counter column as a number; both drivers may hand back a string or bigint. */
export function decodeChangeSeq(value: unknown): number {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq < 0)
    throw new Error(`Invalid node change sequence ${String(value)}`);
  return seq;
}
