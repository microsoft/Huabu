import { isMac } from '@/utils/platform';

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
 * Metadata for a single user-facing shortcut — the single source of truth
 * that feeds every surface which *displays* a shortcut (today: the
 * keyboard-shortcuts help modal; next: the app-menu / dropdown hints).
 *
 * The runtime *handlers* still live in their own components/hooks (they
 * carry context-specific guards that can't be centralized); this catalog
 * only owns the display metadata so those surfaces can't drift apart.
 *
 * - `id`      Stable identity. Not consumed by the help modal itself, but
 *             the anchor the menu / dropdown reference a specific shortcut
 *             by (and the future key for user-rebinding).
 * - `keys`    The existing `Ctrl/Cmd+…` template understood by
 *             `shortcutTokens` / `formatShortcut` in `utils/platform.ts`.
 *             Descriptive gestures (`Space (hold)`, `↑ / ↓`) pass through
 *             unchanged, so this one field covers both real key combos and
 *             documented gestures — no separate representation needed.
 * - `descriptionKey`  i18n key, resolved with `t()` at render time (kept as
 *             a key so the catalog stays a static, side-effect-free const).
 * - `section` i18n key for the group heading in the help modal.
 */
export type ShortcutDef = {
  id: string;
  keys: string;
  descriptionKey: I18nKey;
  section: I18nKey;
};

const SECTION = {
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
    keys: 'Ctrl/Cmd+Z',
    descriptionKey: 'shortcuts.items.undo',
    section: SECTION.editing,
  },
  {
    id: 'edit.redo',
    keys: 'Ctrl/Cmd+Shift+Z',
    descriptionKey: 'shortcuts.items.redo',
    section: SECTION.editing,
  },
  {
    id: 'edit.copy',
    keys: 'Ctrl/Cmd+C',
    descriptionKey: 'shortcuts.items.copySelectedNodes',
    section: SECTION.editing,
  },
  {
    id: 'edit.paste',
    keys: 'Ctrl/Cmd+V',
    descriptionKey: 'shortcuts.items.paste',
    section: SECTION.editing,
  },
  {
    id: 'edit.delete',
    keys: 'Delete / Backspace',
    descriptionKey: 'shortcuts.items.deleteSelected',
    section: SECTION.editing,
  },

  // Layout
  {
    id: 'view.zoomIn',
    keys: 'Ctrl/Cmd+Plus',
    descriptionKey: 'shortcuts.items.zoomIn',
    section: SECTION.layout,
  },
  {
    id: 'view.zoomOut',
    keys: 'Ctrl/Cmd+Minus',
    descriptionKey: 'shortcuts.items.zoomOut',
    section: SECTION.layout,
  },

  // Toolbar (tools + placement modes)
  {
    id: 'tool.temporaryPan',
    keys: 'Space (hold)',
    descriptionKey: 'shortcuts.items.temporaryPan',
    section: SECTION.toolbar,
  },
  {
    id: 'tool.moveWithoutFrame',
    keys: 'Space (hold while dragging)',
    descriptionKey: 'shortcuts.items.moveWithoutFrame',
    section: SECTION.toolbar,
  },
  {
    id: 'tool.select',
    keys: 'S',
    descriptionKey: 'shortcuts.items.selectTool',
    section: SECTION.toolbar,
  },
  {
    id: 'tool.pan',
    keys: 'P',
    descriptionKey: 'shortcuts.items.panTool',
    section: SECTION.toolbar,
  },
  {
    id: 'tool.lasso',
    keys: 'L',
    descriptionKey: 'shortcuts.items.lassoTool',
    section: SECTION.toolbar,
  },
  {
    id: 'mode.frame',
    keys: '1',
    descriptionKey: 'shortcuts.items.frameMode',
    section: SECTION.toolbar,
  },
  {
    id: 'mode.note',
    keys: '2',
    descriptionKey: 'shortcuts.items.noteMode',
    section: SECTION.toolbar,
  },
  {
    id: 'mode.text',
    keys: '3',
    descriptionKey: 'shortcuts.items.textMode',
    section: SECTION.toolbar,
  },
  {
    id: 'mode.sketch',
    keys: '4',
    descriptionKey: 'shortcuts.items.sketchMode',
    section: SECTION.toolbar,
  },
  {
    id: 'mode.audio',
    keys: '5',
    descriptionKey: 'shortcuts.items.audioMode',
    section: SECTION.toolbar,
  },
  {
    id: 'mode.question',
    keys: 'Q',
    descriptionKey: 'shortcuts.items.questionMode',
    section: SECTION.toolbar,
  },

  // Layering & grouping
  {
    id: 'layer.sendBack',
    keys: '[',
    descriptionKey: 'shortcuts.items.sendBack',
    section: SECTION.layeringGrouping,
  },
  {
    id: 'layer.bringFront',
    keys: ']',
    descriptionKey: 'shortcuts.items.bringFront',
    section: SECTION.layeringGrouping,
  },
  {
    id: 'layer.group',
    keys: 'Ctrl/Cmd+G',
    descriptionKey: 'shortcuts.items.groupFrame',
    section: SECTION.layeringGrouping,
  },

  // Drag & drop. Platform-aware: macOS uses Option (matches Finder; Cmd is
  // reserved by the OS for NSDragOperation and cannot be read reliably as a
  // JS drag modifier), Windows / Linux use Ctrl (matches Explorer / Files).
  {
    id: 'dnd.copyNoteBlock',
    keys: isMac
      ? 'Option / ⌥ (hold while dragging)'
      : 'Ctrl (hold while dragging)',
    descriptionKey: 'shortcuts.items.copyNoteBlock',
    section: SECTION.dragDrop,
  },

  // AI
  {
    id: 'ai.openIntent',
    keys: 'Ctrl/Cmd+I',
    descriptionKey: 'shortcuts.items.openIntent',
    section: SECTION.ai,
  },
  {
    id: 'ai.submitQuestion',
    keys: 'Shift+Enter',
    descriptionKey: 'shortcuts.items.submitQuestion',
    section: SECTION.ai,
  },

  // Search
  {
    id: 'search.open',
    keys: 'Ctrl/Cmd+F',
    descriptionKey: 'shortcuts.items.searchCanvas',
    section: SECTION.search,
  },
  {
    id: 'search.jumpResult',
    keys: 'Enter',
    descriptionKey: 'shortcuts.items.jumpResult',
    section: SECTION.search,
  },
  {
    id: 'search.previousMatch',
    keys: 'Shift+Enter',
    descriptionKey: 'shortcuts.items.previousMatch',
    section: SECTION.search,
  },
  {
    id: 'search.moveBetweenResults',
    keys: '↑ / ↓',
    descriptionKey: 'shortcuts.items.moveBetweenResults',
    section: SECTION.search,
  },
  {
    id: 'search.close',
    keys: 'Esc',
    descriptionKey: 'shortcuts.items.closeSearch',
    section: SECTION.search,
  },

  // Help
  {
    id: 'help.show',
    keys: '?',
    descriptionKey: 'shortcuts.items.showShortcuts',
    section: SECTION.help,
  },
  {
    id: 'help.close',
    keys: 'Esc',
    descriptionKey: 'shortcuts.items.closeShortcuts',
    section: SECTION.help,
  },
];

/**
 * Group the catalog into the section shape the help modal consumes,
 * resolving i18n keys with the caller's `t`. Sections keep their
 * first-encounter order from {@link SHORTCUTS}; items keep array order.
 */
export function getKeyboardShortcutSections(t: TFunction): ShortcutSection[] {
  const order: I18nKey[] = [];
  const bySection = new Map<I18nKey, ShortcutItem[]>();

  for (const def of SHORTCUTS) {
    let items = bySection.get(def.section);
    if (!items) {
      items = [];
      bySection.set(def.section, items);
      order.push(def.section);
    }
    items.push({ keys: def.keys, description: t(def.descriptionKey) });
  }

  return order.map((section) => ({
    title: t(section),
    items: bySection.get(section) ?? [],
  }));
}
