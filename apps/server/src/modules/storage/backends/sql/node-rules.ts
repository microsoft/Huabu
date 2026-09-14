// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  decodeNodeRecord,
  requireRevision,
  validateNodeContent,
} from './codecs.js';
import { sanitizeId } from '../../../../utils/fs.js';

import type { NodePutInput, NodeSnapshot } from '../../ports/structured.js';

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
