// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { note, spaceRecord } from './test-fixtures.js';
import { mutationError, validateInput } from './write-rules.js';

import type { SpaceWriteInput } from '../../ports/structured.js';
const input = (): SpaceWriteInput => ({
  expectedVersion: 0,
  nextRecord: { ...spaceRecord(), version: 1 },
  nodeMutations: [],
});
it('accepts a structural write and rejects invalid version transitions', () => {
  expect(() => validateInput('space', input())).not.toThrow();
  expect(() =>
    validateInput('space', { ...input(), expectedVersion: NaN }),
  ).toThrow(/finite/);
  expect(() =>
    validateInput('space', { ...input(), expectedVersion: 1 }),
  ).toThrow(/version/);
});
it('restricts creation to structural writes and validates nodes and deltas', () => {
  expect(() =>
    validateInput('space', {
      ...input(),
      allowCreate: true,
      nodeMutations: [{ kind: 'put', nodeId: 'node', record: note() }],
    }),
  ).toThrow(/record-only/);
  expect(() =>
    validateInput('space', {
      ...input(),
      nodeMutations: [{ kind: 'delete', nodeId: '../bad' }],
    }),
  ).toThrow();
  expect(() =>
    validateInput('space', { ...input(), delta: { version: 2 } as never }),
  ).toThrow(/delta.version/);
  expect(() =>
    validateInput('space', {
      ...input(),
      nodeMutations: [{ kind: 'put', nodeId: 'other', record: note() }],
    }),
  ).toThrow(/mismatch/);
});
it.each([
  'not-found',
  'revision-conflict',
  'label-conflict',
  'duplicate-node',
  'write-suppressed',
] as const)('reports %s with node context', (reason) => {
  expect(
    mutationError({ kind: 'delete', nodeId: 'node' }, {
      ok: false,
      reason,
      conflictingNodeId: 'other',
    } as never).message,
  ).toContain('Space write failed for node "node"');
});
