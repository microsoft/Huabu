// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import {
  allocateNodeIdentity,
  allocateSpaceIdentity,
  collisionKeyForTitle,
} from './identity.js';
import { note } from './test-fixtures.js';
it('deduplicates case-insensitive titles while retaining their display text', () => {
  expect(
    allocateSpaceIdentity('Title', 'space', ['title', 'title (2)']),
  ).toEqual({ title: 'Title (3)', collisionKey: 'title (3)' });
  expect(allocateSpaceIdentity(null, 'space', [])).toEqual({
    title: null,
    collisionKey: 'space',
  });
  expect(collisionKeyForTitle('Title', 'space')).toBe(
    collisionKeyForTitle('TITLE', 'space'),
  );
});
it('retains an existing identity when a node loses its label', () => {
  const record = { ...note(), label: null };
  expect(allocateNodeIdentity(record, 'node', 'old', ['old'])).toEqual({
    record,
    collisionKey: 'old',
    desiredCollisionKey: 'old',
  });
});
it('allocates node suffixes without mutating the input or hiding the desired key', () => {
  const record = note('Title');
  expect(allocateNodeIdentity(record, 'node', null, ['title'])).toEqual({
    record: { ...record, label: 'Title (2)' },
    collisionKey: 'title (2)',
    desiredCollisionKey: 'title',
  });
  expect(record.label).toBe('Title');
  expect(
    allocateNodeIdentity({ ...note(), label: ' ' }, 'node', null, [])
      .collisionKey,
  ).toBe('node');
});
