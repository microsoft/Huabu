// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import {
  collectNodeRow,
  decodeIdentifiedNodeRow,
  decodeNodeRow,
  validatePut,
} from './node-rules.js';
import { nodeRow, note } from './test-fixtures.js';

import type { NodeSnapshot } from '../../ports/structured.js';
it('decodes and collects snapshots by persisted id', () => {
  const snapshot = { record: note(), revision: 'revision' };
  expect(decodeIdentifiedNodeRow(nodeRow())).toEqual(['node', snapshot]);
  const into = new Map<string, NodeSnapshot>();
  collectNodeRow(nodeRow(), into);
  expect(into.get('node')).toEqual(snapshot);
});
it.each([
  null,
  [],
  {},
  { ...nodeRow(), revision: '' },
  { ...nodeRow(), label_collision_key: null },
])('rejects invalid node rows %j', (row) => {
  expect(() => decodeNodeRow(row, 'node')).toThrow(SyntaxError);
});
it('requires a persisted node id and validates CAS input before writing', () => {
  expect(() => decodeIdentifiedNodeRow({ ...nodeRow(), node_id: 1 })).toThrow(
    SyntaxError,
  );
  for (const expectedRevision of [undefined, null, 'token'])
    expect(
      validatePut({ nodeId: 'node', record: note(), expectedRevision }),
    ).toBe('node');
  expect(() =>
    validatePut({
      nodeId: 'node',
      record: note(),
      expectedRevision: 3,
    } as never),
  ).toThrow(/expectedRevision/);
  expect(() => validatePut({ nodeId: '../node', record: note() })).toThrow();
});
