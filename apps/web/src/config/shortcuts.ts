// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isElectron } from '@/hooks/useElectron';
import { formatShortcut, isMac } from '@/utils/platform';

import type { ParseKeys, TFunction } from 'i18next';

/**
 * The strongly-typed i18n key accepted by `t()`. Typing the catalog's
 * `descriptionKey` / `section` as this (instead of `string`) both lets
 * them be passed straight to `t()` and validates every key at definition
 * time — a typo in the catalog fails the build.
 */
type I18nKey = ParseKeys;

export type ShortcutItem = {
  keys: string;
  description: string;
};

export type ShortcutSection = {
  title: string;
  items: ShortcutItem[];
};

/**
 * A real, matchable key combo — the canonical (machine-first) form. Handlers
 * compare a `KeyboardEvent` against this directly (no string parsing); the
 * display template is *derived* from it via `comboToTemplate`.
 *
 * - `mod`   Cmd on macOS / Ctrl elsewhere.
 * - `key`   The main key, compared against `KeyboardEvent.key`. An array
 *           means "any of" — aliases or multi-bindings (`['[', '【']`,
 *           `['+', '=']`); the FIRST entry is the one shown in the UI.
 */
export type KeyCombo = {
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  key: string | string[];
};

/**
 * Metadata for a single user-facing shortcut — the single source of truth
 * feeding every surface that *displays* a shortcut (help modal, docs page,
 * AppMenu dropdown hints). Runtime *handlers* stay in their own
 * components/hooks (context-specific guards can't be centralized) but match
 * against `combo` directly, so display and behaviour can't drift.
 *
 * Each entry is EITHER a `combo` (a real, matchable key combination) OR a
 * `gesture` (a display-only string for things that aren't a plain combo:
 * `Space (hold)`, `↑ / ↓`, the drag-copy modifier). The union enforces
 * exactly one of the two.
 *
 * `descriptionKey` / `section` are i18n keys resolved with `t()` at render
 * time, so the catalog stays a static, side-effect-free const.
 */
export type ShortcutDef = {
  id: string;
  descriptionKey: I18nKey;
  section: I18nKey;
  /** Keep an internal binding out of user-facing shortcut lists. */
  hidden?: boolean;
} & ({ combo: KeyCombo; gesture?: never } | { gesture: string; combo?: never });

/**
 * Placeholder tokens for keys that would collide with the `+` separator in
 * the display template (mirrors `utils/platform.ts`), plus friendlier
 * labels for a couple of named keys.
 */
const COMBO_DISPLAY_TOKEN: Record<string, string> = {
  '+': 'Plus',
  '-': 'Minus',
  '=': 'Equal',
  Escape: 'Esc',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/**
 * Derive the legacy `Ctrl/Cmd+…` display template from a {@link KeyCombo} so
 * the existing string-based renderers (`shortcutTokens`, the docs
 * `ShortcutKbd`) and `formatShortcut` keep working unchanged. Uses the
 * FIRST key of an alias array for display; single-letter keys are
 * upper-cased.
 */
function comboToTemplate(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.mod) parts.push('Ctrl/Cmd');
  if (combo.shift) parts.push('Shift');
  if (combo.alt) parts.push('Alt');
  const primary = Array.isArray(combo.key) ? combo.key[0] : combo.key;
  parts.push(
    COMBO_DISPLAY_TOKEN[primary] ??
      (primary.length === 1 ? primary.toUpperCase() : primary),
  );
  return parts.join('+');
}

/** The display template for any def, whether a `combo` or a `gesture`. */
function shortcutTemplate(def: ShortcutDef): string {
  return def.combo ? comboToTemplate(def.combo) : def.gesture;
}

const SECTION = {
  general: 'shortcuts.sections.general',
  editing: 'shortcuts.sections.editing',
  layout: 'shortcuts.sections.layout',
  toolbar: 'shortcuts.sections.toolbar',
  layeringGrouping: 'shortcuts.sections.layeringGrouping',
  dragDrop: 'shortcuts.sections.dragDrop',
  ai: 'shortcuts.sections.ai',
  search: 'shortcuts.sections.search',
  help: 'shortcuts.sections.help',
} as const;

/**
 * The shortcut catalog. Order within a section is preserved in the help
 * modal; sections appear in first-encounter order below.
 */
export const SHORTCUTS: ShortcutDef[] = [
  // Editing
  {
    id: 'edit.undo',
    combo: { mod: true, key: 'z' },
    descriptionKey: 'shortcuts.items.undo',
    section: SECTION.editing,
  },
  {
    id: 'edit.redo',
    combo: { mod: true, shift: true, key: 'z' },
    descriptionKey: 'shortcuts.items.redo',
    section: SECTION.editing,
  },
  {
    id: 'edit.copy',
    combo: { mod: true, key: 'c' },
    descriptionKey: 'shortcuts.items.copySelectedNodes',
    section: SECTION.editing,
  },
  {
    id: 'edit.paste',
    combo: { mod: true, key: 'v' },
    descriptionKey: 'shortcuts.items.paste',
    section: SECTION.editing,
  },
  {
    id: 'edit.delete',
    gesture: 'Delete / Backspace',
    descriptionKey: 'shortcuts.items.deleteSelected',
    section: SECTION.editing,
  },
  {
    id: 'edit.edgeLabel',
    combo: { key: 'Enter' },
    descriptionKey: 'shortcuts.items.editEdgeLabel',
    section: SECTION.editing,
  },

  // Layout
  {
    id: 'view.zoomIn',
    combo: { mod: true, key: ['+', '='] },
    descriptionKey: 'shortcuts.items.zoomIn',
    section: SECTION.layout,
  },
  {
    id: 'view.zoomOut',
    combo: { mod: true, key: ['-', '_'] },
    descriptionKey: 'shortcuts.items.zoomOut',
    section: SECTION.layout,
  },
  {
    id: 'node.navigateUpstream',
    combo: { key: 'ArrowLeft' },
    descriptionKey: 'shortcuts.items.navigateUpstream',
    section: SECTION.layout,
  },
  {
    id: 'node.navigateDownstream',
    combo: { key: 'ArrowRight' },
    descriptionKey: 'shortcuts.items.navigateDownstream',
    section: SECTION.layout,
  },

  // Toolbar (tools + placement modes)
  {
    id: 'tool.temporaryPan',
    gesture: 'Space (hold)',
    descriptionKey: 'shortcuts.items.temporaryPan',
    section: SECTION.toolbar,
  },
  {
    id: 'tool.moveWithoutFrame',
    gesture: 'Space (hold while dragging)',
    descriptionKey: 'shortcuts.items.moveWithoutFrame',
    section: SECTION.toolbar,
  },
  {
    id: 'tool.select',
    combo: { key: 's' },
    descriptionKey: 'shortcuts.items.selectTool',
    section: SECTION.toolbar,
  },
  {
    id: 'tool.pan',
    combo: { key: 'p' },
    descriptionKey: 'shortcuts.items.panTool',
    section: SECTION.toolbar,
  },
  {
    id: 'tool.lasso',
    combo: { key: 'l' },
    descriptionKey: 'shortcuts.items.lassoTool',
    section: SECTION.toolbar,
  },
  {
    id: 'mode.frame',
    combo: { key: '3' },
    descriptionKey: 'shortcuts.items.frameMode',
    section: SECTION.toolbar,
  },
  {
    id: 'mode.note',
    combo: { key: '1' },
    descriptionKey: 'shortcuts.items.noteMode',
    section: SECTION.toolbar,
  },
  {
    id: 'mode.text',
    combo: { key: '2' },
    descriptionKey: 'shortcuts.items.textMode',
    section: SECTION.toolbar,
  },
  {
    id: 'mode.sketch',
    combo: { key: '4' },
    descriptionKey: 'shortcuts.items.sketchMode',
    section: SECTION.toolbar,
  },
  {
    id: 'mode.audio',
    combo: { key: '5' },
    descriptionKey: 'shortcuts.items.audioMode',
    section: SECTION.toolbar,
  },
  {
    id: 'mode.question',
    combo: { key: 'a' },
    descriptionKey: 'shortcuts.items.questionMode',
    section: SECTION.toolbar,
  },

  // Layering & grouping
  {
    id: 'layer.sendBack',
    combo: { key: ['[', '【'] },
    descriptionKey: 'shortcuts.items.sendBack',
    section: SECTION.layeringGrouping,
  },
  {
    id: 'layer.bringFront',
    combo: { key: [']', '】'] },
    descriptionKey: 'shortcuts.items.bringFront',
    section: SECTION.layeringGrouping,
  },
  {
    id: 'layer.group',
    combo: { mod: true, key: 'g' },
    descriptionKey: 'shortcuts.items.groupFrame',
    section: SECTION.layeringGrouping,
  },

  // Drag & drop (display-only gesture; the modifier is read off the drag
  // event, not a keydown). Platform-aware: macOS uses Option (Cmd is
  // reserved by the OS for NSDragOperation and can't be read as a JS drag
  // modifier), Windows / Linux use Ctrl.
  {
    id: 'dnd.copyNoteBlock',
    gesture: isMac
      ? 'Option / ⌥ (hold while dragging)'
      : 'Ctrl (hold while dragging)',
    descriptionKey: 'shortcuts.items.copyNoteBlock',
    section: SECTION.dragDrop,
  },

  // Search
  {
    id: 'search.open',
    combo: { mod: true, key: 'f' },
    descriptionKey: 'shortcuts.items.searchCanvas',
    section: SECTION.search,
  },
  {
    id: 'search.jumpResult',
    combo: { key: 'Enter' },
    descriptionKey: 'shortcuts.items.jumpResult',
    section: SECTION.search,
  },
  {
    id: 'search.previousMatch',
    combo: { shift: true, key: 'Enter' },
    descriptionKey: 'shortcuts.items.previousMatch',
    section: SECTION.search,
  },
  {
    id: 'search.moveBetweenResults',
    gesture: '↑ / ↓',
    descriptionKey: 'shortcuts.items.moveBetweenResults',
    section: SECTION.search,
  },
  {
    id: 'search.close',
    combo: { key: 'Escape' },
    descriptionKey: 'shortcuts.items.closeSearch',
    section: SECTION.search,
  },

  // Help
  {
    id: 'help.show',
    combo: { key: '?' },
    descriptionKey: 'shortcuts.items.showShortcuts',
    section: SECTION.help,
  },
  {
    id: 'help.close',
    combo: { key: 'Escape' },
    descriptionKey: 'shortcuts.items.closeShortcuts',
    section: SECTION.help,
  },
];

/**
 * App-level shortcuts (New Canvas, Settings) — same `ShortcutDef` shape as
 * {@link SHORTCUTS}, kept in a separate array because they live app-wide
 * rather than inside the canvas. The help modal lists them only where they
 * actually work (Electron; see {@link getKeyboardShortcutSections}), and
 * the `AppMenu` dropdown reads their `keys` by id for its hints.
 *
 * The `?` help shortcut is intentionally NOT here — it already lives in
 * {@link SHORTCUTS} as `help.show`, so both the dropdown hint and the help
 * modal source it from that single entry.
 */
export const APP_SHORTCUTS: ShortcutDef[] = [
  {
    id: 'app.newCanvas',
    combo: { mod: true, key: 'n' },
    descriptionKey: 'shortcuts.items.newCanvas',
    section: SECTION.general,
  },
  {
    id: 'app.openSettings',
    combo: { mod: true, key: ',' },
    descriptionKey: 'shortcuts.items.openSettings',
    section: SECTION.general,
  },
];

const SHORTCUTS_BY_ID = new Map(
  [...SHORTCUTS, ...APP_SHORTCUTS].map((s) => [s.id, s] as const),
);

/**
 * Look up a shortcut's display `keys` template by id across both catalogs
 * (derived from its `combo`, or the raw `gesture` string). Used by the
 * `AppMenu` dropdown so its hints come from the same definitions the help
 * modal renders. Format with `formatShortcut`.
 */
export function getShortcutKeys(id: string): string | undefined {
  const def = SHORTCUTS_BY_ID.get(id);
  return def ? shortcutTemplate(def) : undefined;
}

/**
 * A ready-to-display shortcut string for `id`, rendered with OS-appropriate
 * notation (`⌘F` on macOS, `Ctrl+F` elsewhere). Returns `''` for unknown ids
 * so callers can interpolate it unconditionally. Prefer this over baking key
 * hints into i18n strings, so a tooltip like `Close (Esc)` derives its
 * shortcut from the same catalog the help modal renders instead of drifting.
 */
export function formatShortcutById(id: string): string {
  const keys = getShortcutKeys(id);
  return keys ? formatShortcut(keys) : '';
}

/**
 * Look up a shortcut's {@link KeyCombo} by id. Returns `undefined` for an
 * unknown id and for gesture-only entries (which have no matchable combo).
 * Handlers use this so the key they fire on comes from the same definition
 * the UI displays — closing the display-vs-behaviour drift.
 */
export function getCombo(id: string): KeyCombo | undefined {
  return SHORTCUTS_BY_ID.get(id)?.combo;
}

/**
 * Does a keyboard event match a {@link KeyCombo}? Pure comparison, no
 * string parsing. `key` is compared case-insensitively against
 * `KeyboardEvent.key`; an array matches any of its entries (aliases /
 * multi-bindings). `shift` / `alt` are compared strictly, so e.g. `⌘Z`
 * does not also fire on `⌘⇧Z`.
 *
 * `mod` requires the platform accelerator modifier but accepts EITHER
 * Cmd or Ctrl on both platforms (Cmd is the canonical one on macOS, Ctrl
 * elsewhere) — a laptop with an external PC keyboard still triggers
 * `⌘`-labelled shortcuts via Ctrl, and vice versa. A `combo` without
 * `mod` still requires both to be absent, so a plain-letter shortcut
 * never steals Cmd/Ctrl combos.
 *
 * Note: symbol keys whose character is itself produced by Shift (e.g. `?`
 * = Shift+/) don't fit the strict-shift model — such shortcuts keep their
 * own bespoke check rather than going through `matches`.
 */
export function matches(e: KeyboardEvent, combo: KeyCombo): boolean {
  if ((e.metaKey || e.ctrlKey) !== !!combo.mod) return false;
  if (e.shiftKey !== !!combo.shift) return false;
  if (e.altKey !== !!combo.alt) return false;
  const keys = Array.isArray(combo.key) ? combo.key : [combo.key];
  const eventKey = e.key.toLowerCase();
  return keys.some((k) => k.toLowerCase() === eventKey);
}

/**
 * Convenience wrapper: does the event match the combo registered under
 * `id`? `false` for unknown ids and gesture-only entries. Handlers use this
 * so the key they fire on is sourced from the catalog the UI displays.
 */
export function matchesShortcut(e: KeyboardEvent, id: string): boolean {
  const combo = getCombo(id);
  return combo ? matches(e, combo) : false;
}

/**
 * Group the catalog into the section shape the help modal consumes,
 * resolving i18n keys with the caller's `t`. Sections keep their
 * first-encounter order from {@link SHORTCUTS}; items keep array order.
 */
export function getKeyboardShortcutSections(t: TFunction): ShortcutSection[] {
  const order: I18nKey[] = [];
  const bySection = new Map<I18nKey, ShortcutItem[]>();

  // App-level shortcuts lead the list, but only where they actually work
  // (Electron). In a plain browser Cmd/Ctrl+N is reserved by the OS for a
  // new window, so listing it would mislead.
  const defs = (
    isElectron() ? [...APP_SHORTCUTS, ...SHORTCUTS] : SHORTCUTS
  ).filter((def) => !def.hidden);

  for (const def of defs) {
    let items = bySection.get(def.section);
    if (!items) {
      items = [];
      bySection.set(def.section, items);
      order.push(def.section);
    }
    items.push({
      keys: shortcutTemplate(def),
      description: t(def.descriptionKey),
    });
  }

  return order.map((section) => ({
    title: t(section),
    items: bySection.get(section) ?? [],
  }));
}
