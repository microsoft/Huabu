// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  decodeNodeRecord,
  decodeSpaceRow,
  parseJson,
  requireRevision,
  stringifyJson,
  validateCanvasFile,
  validateNodeContent,
} from './codecs.js';
import { note, spaceRecord, spaceRow } from './test-fixtures.js';

describe('JSON persistence', () => {
  it('matches JSON undefined rules and accepts shared references without mistaking them for cycles', () => {
    const shared = { text: '你好', optional: undefined };
    expect(
      JSON.parse(
        stringifyJson({ a: shared, b: shared, array: [undefined] }, 'test'),
      ),
    ).toEqual({ a: { text: '你好' }, b: { text: '你好' }, array: [null] });
    expect(
      stringifyJson(Object.assign(Object.create(null), { a: 1 }), 'test'),
    ).toBe('{"a":1}');
  });
  it.each([
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol('s'),
    () => {},
    new Date(),
    new Map(),
    new Array(2),
    undefined,
  ])('rejects lossy JSON value %s', (value) => {
    expect(() => stringifyJson(value, 'test')).toThrow(TypeError);
  });
  it('rejects cycles and reports the damaged context', () => {
    const value: Record<string, unknown> = {};
    value['self'] = value;
    expect(() => stringifyJson(value, 'document')).toThrow(
      /document.self.*cycle/,
    );
    expect(() => parseJson('{', 'document')).toThrow(
      /Invalid JSON in document/,
    );
    expect(() => parseJson({}, 'document')).toThrow(/JSON text/);
  });
});
it('round trips space columns and validates world identity', () => {
  expect(decodeSpaceRow(spaceRow())).toEqual({
    record: spaceRecord(),
    workspaceId: 'workspace',
    collisionKey: 'title',
    isWorld: false,
  });
  expect(
    decodeSpaceRow({ ...spaceRow(), is_world: 1, title: null }).isWorld,
  ).toBe(true);
});
it.each([
  'canvas_id',
  'workspace_id',
  'collision_key',
  'title',
  'version',
  'created_at',
  'updated_at',
  'state_json',
  'is_world',
])('rejects damaged space column %s', (column) => {
  expect(() => decodeSpaceRow({ ...spaceRow(), [column]: undefined })).toThrow(
    SyntaxError,
  );
});
it.each([
  null,
  [],
  {},
  { ...spaceRow(), is_world: 2 },
  { ...spaceRow(), version: NaN },
  { ...spaceRow(), state_json: '{}' },
])('rejects invalid persisted spaces %s', (row) => {
  expect(() => decodeSpaceRow(row)).toThrow(SyntaxError);
});
it('rejects writes with mismatched identities or non-JSON state', () => {
  expect(() => validateCanvasFile(spaceRecord(), 'other')).toThrow();
  expect(() => validateNodeContent(note(), 'other')).toThrow(/mismatch/);
  expect(() =>
    validateNodeContent({ ...note(), content: 1 } as never, 'node'),
  ).toThrow(/content/);
});
it.each([
  null,
  [],
  5,
  { content: 7 },
  { nodeId: 'wrong', type: 'note', label: 'kept', content: 'kept' },
])('preserves repairable node content %j', (stored) => {
  const recovered = decodeNodeRecord(JSON.stringify(stored), 'node');
  expect(recovered.nodeId).toBe('node');
  expect(typeof recovered.content).toBe('string');
  expect(() => validateNodeContent(recovered, 'node')).not.toThrow();
});
it('round trips healthy nodes and rejects invalid JSON and revision tokens', () => {
  expect(decodeNodeRecord(JSON.stringify(note()), 'node')).toEqual(note());
  expect(() => decodeNodeRecord('{', 'node')).toThrow(SyntaxError);
  for (const value of [null, '', 1])
    expect(() => requireRevision(value, 'node')).toThrow(SyntaxError);
  expect(requireRevision('opaque-token', 'node')).toBe('opaque-token');
});
