// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { decodeWorkspaceRow, requireName } from './workspace-rules.js';
it('trims names without altering Unicode', () => {
  expect(requireName('  工作区  ')).toBe('工作区');
  expect(
    decodeWorkspaceRow({ workspace_id: 'id', name: '工作区', created_at: 1 }),
  ).toEqual({ workspaceId: 'id', name: '工作区' });
});
it.each([null, 3, '', '  '])('rejects invalid names %j', (value) => {
  expect(() => requireName(value)).toThrow(TypeError);
});
it.each([
  null,
  [],
  {},
  { workspace_id: '', name: 'Name' },
  { workspace_id: 'id', name: null },
])('rejects invalid rows %j', (value) => {
  expect(() => decodeWorkspaceRow(value)).toThrow(SyntaxError);
});
