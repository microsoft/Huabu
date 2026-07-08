import { isMac } from '@/utils/platform';

import type { TFunction } from 'i18next';

export type ShortcutItem = {
  keys: string;
  description: string;
};

export type ShortcutSection = {
  title: string;
  items: ShortcutItem[];
};

export function getKeyboardShortcutSections(t: TFunction): ShortcutSection[] {
  return [
    {
      title: t('shortcuts.sections.editing'),
      items: [
        { keys: 'Ctrl/Cmd+Z', description: t('shortcuts.items.undo') },
        { keys: 'Ctrl/Cmd+Shift+Z', description: t('shortcuts.items.redo') },
        {
          keys: 'Ctrl/Cmd+C',
          description: t('shortcuts.items.copySelectedNodes'),
        },
        {
          keys: 'Ctrl/Cmd+V',
          description: t('shortcuts.items.paste'),
        },
        {
          keys: 'Delete / Backspace',
          description: t('shortcuts.items.deleteSelected'),
        },
      ],
    },
    {
      title: t('shortcuts.sections.layout'),
      items: [
        { keys: 'Ctrl/Cmd+Plus', description: t('shortcuts.items.zoomIn') },
        { keys: 'Ctrl/Cmd+Minus', description: t('shortcuts.items.zoomOut') },
      ],
    },
    {
      title: t('shortcuts.sections.toolbar'),
      items: [
        {
          keys: 'Space (hold)',
          description: t('shortcuts.items.temporaryPan'),
        },
        {
          keys: 'Space (hold while dragging)',
          description: t('shortcuts.items.moveWithoutFrame'),
        },
        { keys: 'S', description: t('shortcuts.items.selectTool') },
        { keys: 'P', description: t('shortcuts.items.panTool') },
        { keys: 'L', description: t('shortcuts.items.lassoTool') },
        { keys: '1', description: t('shortcuts.items.frameMode') },
        { keys: '2', description: t('shortcuts.items.noteMode') },
        { keys: '3', description: t('shortcuts.items.textMode') },
        { keys: '4', description: t('shortcuts.items.sketchMode') },
        { keys: 'Q', description: t('shortcuts.items.questionMode') },
      ],
    },
    {
      title: t('shortcuts.sections.layeringGrouping'),
      items: [
        { keys: '[', description: t('shortcuts.items.sendBack') },
        { keys: ']', description: t('shortcuts.items.bringFront') },
        { keys: 'Ctrl/Cmd+G', description: t('shortcuts.items.groupFrame') },
      ],
    },
    {
      title: t('shortcuts.sections.dragDrop'),
      items: [
        {
          // Platform-aware: macOS uses Option (matches Finder; Cmd is
          // reserved by the OS for NSDragOperation and cannot be read
          // reliably as a JS drag modifier), Windows / Linux use Ctrl
          // (matches Explorer / Files).
          keys: isMac
            ? 'Option / ⌥ (hold while dragging)'
            : 'Ctrl (hold while dragging)',
          description: t('shortcuts.items.copyNoteBlock'),
        },
      ],
    },
    {
      title: t('shortcuts.sections.ai'),
      items: [
        { keys: 'Ctrl/Cmd+I', description: t('shortcuts.items.openIntent') },
        {
          keys: 'Shift+Enter',
          description: t('shortcuts.items.submitQuestion'),
        },
      ],
    },
    {
      title: t('shortcuts.sections.search'),
      items: [
        {
          keys: 'Ctrl/Cmd+F',
          description: t('shortcuts.items.searchCanvas'),
        },
        { keys: 'Enter', description: t('shortcuts.items.jumpResult') },
        {
          keys: 'Shift+Enter',
          description: t('shortcuts.items.previousMatch'),
        },
        {
          keys: '↑ / ↓',
          description: t('shortcuts.items.moveBetweenResults'),
        },
        { keys: 'Esc', description: t('shortcuts.items.closeSearch') },
      ],
    },
    {
      title: t('shortcuts.sections.help'),
      items: [
        { keys: '?', description: t('shortcuts.items.showShortcuts') },
        { keys: 'Esc', description: t('shortcuts.items.closeShortcuts') },
      ],
    },
  ];
}
