// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { keyboardShortcutSections } from './shortcuts';

describe('handbook keyboard shortcut catalog', () => {
  it('documents the public shortcuts in canonical section order', () => {
    expect(keyboardShortcutSections.map((section) => section.title)).toEqual([
      'General',
      'Editing',
      'Layout',
      'Toolbar',
      'Layering & Grouping',
      'Drag and drop',
      'Search',
      'Help',
    ]);
    expect(
      keyboardShortcutSections.flatMap((section) => section.items),
    ).toHaveLength(31);
  });

  it('uses the toolbar bindings registered by the app', () => {
    const toolbar = keyboardShortcutSections.find(
      (section) => section.title === 'Toolbar',
    );
    expect(toolbar?.items).toEqual(
      expect.arrayContaining([
        { keys: '1', description: 'Note placement mode' },
        { keys: '2', description: 'Text placement mode' },
        { keys: '3', description: 'Frame placement mode' },
        { keys: '4', description: 'Sketch mode' },
        { keys: '5', description: 'Audio placement mode' },
        { keys: 'A', description: 'Create Agent Node' },
      ]),
    );
  });
});
