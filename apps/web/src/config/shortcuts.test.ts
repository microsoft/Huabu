// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  APP_SHORTCUTS,
  formatShortcutById,
  getCombo,
  getKeyboardShortcutSections,
  matches,
  SHORTCUTS,
  type KeyCombo,
} from './shortcuts';

/** Build a minimal `KeyboardEvent`-shaped object for the fields `matches` reads. */
function keydown(init: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  code?: string;
}): KeyboardEvent {
  return {
    key: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    code: init.code ?? '',
  } as KeyboardEvent;
}

describe('matches', () => {
  it('matches a mod+key combo, case-insensitively and via Cmd or Ctrl', () => {
    const combo: KeyCombo = { mod: true, key: 'z' };
    expect(matches(keydown({ key: 'z', metaKey: true }), combo)).toBe(true);
    expect(matches(keydown({ key: 'Z', ctrlKey: true }), combo)).toBe(true);
  });

  it('compares shift strictly (undo vs redo do not collide)', () => {
    const undo: KeyCombo = { mod: true, key: 'z' };
    const redo: KeyCombo = { mod: true, shift: true, key: 'z' };
    const withShift = keydown({ key: 'z', metaKey: true, shiftKey: true });
    expect(matches(withShift, undo)).toBe(false);
    expect(matches(withShift, redo)).toBe(true);
  });

  it('requires the modifier to be present', () => {
    expect(matches(keydown({ key: 'z' }), { mod: true, key: 'z' })).toBe(false);
  });

  it('matches any key in an alias array', () => {
    const combo: KeyCombo = { key: ['[', '【'] };
    expect(matches(keydown({ key: '[' }), combo)).toBe(true);
    expect(matches(keydown({ key: '【' }), combo)).toBe(true);
    expect(matches(keydown({ key: ']' }), combo)).toBe(false);
  });

  it.each([
    ['view.fitAll', '!', 'Digit1'],
    ['view.fitSelection', '@', 'Digit2'],
    ['view.fitSelection', '"', 'Digit2'],
  ])(
    'matches %s by physical digit while retaining modifier guards',
    (id, key, code) => {
      const combo = getCombo(id);
      if (!combo) throw new Error(`Missing shortcut ${id}`);
      expect(matches(keydown({ key, code, shiftKey: true }), combo)).toBe(true);
      expect(matches(keydown({ key, code }), combo)).toBe(false);
      expect(
        matches(keydown({ key, code, shiftKey: true, metaKey: true }), combo),
      ).toBe(false);
      expect(
        matches(keydown({ key, code, shiftKey: true, altKey: true }), combo),
      ).toBe(false);
    },
  );

  it('every catalog combo matches a synthetic event for its primary key', () => {
    for (const def of [...SHORTCUTS, ...APP_SHORTCUTS]) {
      if (!def.combo) continue;
      const primary = Array.isArray(def.combo.key)
        ? def.combo.key[0]
        : def.combo.key;
      const event = keydown({
        key: primary,
        metaKey: !!def.combo.mod,
        shiftKey: !!def.combo.shift,
        altKey: !!def.combo.alt,
      });
      expect(matches(event, def.combo), def.id).toBe(true);
    }
  });
});

describe('getCombo', () => {
  it('returns the combo for a combo entry', () => {
    expect(getCombo('app.newCanvas')).toEqual({ mod: true, key: 'n' });
    expect(getCombo('app.openSettings')).toEqual({ mod: true, key: ',' });
  });

  it('returns undefined for a gesture entry and an unknown id', () => {
    // `search.moveBetweenResults` is a display-only gesture (↑ / ↓).
    expect(getCombo('search.moveBetweenResults')).toBeUndefined();
    expect(getCombo('does.not.exist')).toBeUndefined();
  });
});

describe('formatShortcutById', () => {
  it('uses directional glyphs for expanded-node navigation', () => {
    expect(formatShortcutById('node.navigateUpstream')).toBe('←');
    expect(formatShortcutById('node.navigateDownstream')).toBe('→');
  });

  it('displays digit shortcuts rather than their shifted punctuation', () => {
    expect(formatShortcutById('view.fitAll')).toMatch(/^(⇧1|Shift\+1)$/);
    expect(formatShortcutById('view.fitSelection')).toMatch(/^(⇧2|Shift\+2)$/);
    expect(formatShortcutById('view.resetZoom')).toMatch(/^(⌘0|Ctrl\+0)$/);
  });
});

describe('getKeyboardShortcutSections', () => {
  it('omits internal bindings and removed shortcuts', () => {
    const t = ((key: string) => key) as never;
    const sections = getKeyboardShortcutSections(t);
    const descriptions = sections.flatMap((section) =>
      section.items.map((item) => item.description),
    );

    expect(getCombo('ai.submitQuestion')).toBeUndefined();
    expect(descriptions).not.toContain('shortcuts.items.submitQuestion');
    expect(descriptions).toContain('canvasControls.resetZoom');
    expect(descriptions).toContain('canvasControls.fitAll');
    expect(descriptions).toContain('canvasControls.fitSelection');
  });
});
