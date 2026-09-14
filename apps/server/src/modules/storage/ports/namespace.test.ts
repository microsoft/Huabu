// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { assertValidNamespace, SpaceNamespaceError } from './namespace.js';

describe('extension namespace grammar', () => {
  it.each(['huabu.memory', 'agenetes.acp', 'huabu.prompt.log', 'owner2.name3'])(
    'accepts %s',
    (namespace) => {
      expect(assertValidNamespace(namespace)).toBe(namespace);
    },
  );

  it.each([
    // No owner prefix — the collision this token exists to prevent.
    ['memory'],
    ['huabu'],
    // Reserved because a backend keyed on identifiers folds the dots into
    // `_`; allowing it here would make that fold ambiguous.
    ['huabu.mem_ory'],
    ['huabu_memory'],
    ['huabu.prompt-log'],
    // Case-insensitive filesystems and case-folding identifiers would let
    // these share one place with their lowercase spelling.
    ['Huabu.Memory'],
    // Empty or digit-led segments have no legal spelling as an identifier.
    ['huabu.'],
    ['.memory'],
    ['huabu..memory'],
    ['1huabu.memory'],
    ['huabu.2memory'],
    // Path traversal is not special-cased; it simply is not the grammar.
    ['../escape'],
    ['huabu/memory'],
    [''],
  ])('rejects %j', (namespace) => {
    expect(() => assertValidNamespace(namespace)).toThrow(SpaceNamespaceError);
  });

  it('rejects a namespace too long to leave room for an owner’s own suffixes', () => {
    const long = `huabu.${'a'.repeat(64)}`;
    expect(() => assertValidNamespace(long)).toThrow(/longer than/);
  });
});
