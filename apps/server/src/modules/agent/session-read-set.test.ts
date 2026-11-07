// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { getSessionReadSet } from './session-read-set.js';

it('does not reuse read-before-write revisions across same-ID namespace owners', () => {
  const a = { name: 'space', ownerId: 'workspace-a' };
  const b = { name: 'space', ownerId: 'workspace-b' };
  const first = getSessionReadSet('read-set-collision', a);
  first.set('same-node', 'A-private-revision');
  expect(getSessionReadSet('read-set-collision', b).size).toBe(0);
  expect(getSessionReadSet('read-set-collision', a)).toBe(first);
  expect(
    getSessionReadSet('read-set-collision', {
      ...a,
      storage: { root: '/moved' },
    }),
  ).toBe(first);
});

it('keeps stateless read sets ephemeral', () => {
  expect(getSessionReadSet(undefined)).not.toBe(getSessionReadSet(undefined));
});
