// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export type ShortcutSection = {
  title: string;
  items: Array<{ keys: string; description: string }>;
};

/** Public English subset of the app's user-facing shortcut catalog. */
export const keyboardShortcutSections: ShortcutSection[] = [
  {
    title: 'General',
    items: [
      { keys: 'Ctrl/Cmd+N', description: 'New Space (desktop app only)' },
      {
        keys: 'Ctrl/Cmd+,',
        description: 'Open settings (desktop app only)',
      },
    ],
  },
  {
    title: 'Editing',
    items: [
      { keys: 'Ctrl/Cmd+Z', description: 'Undo' },
      { keys: 'Ctrl/Cmd+Shift+Z', description: 'Redo' },
      { keys: 'Ctrl/Cmd+C', description: 'Copy selected nodes' },
      {
        keys: 'Ctrl/Cmd+V',
        description: 'Paste nodes, files, URLs, or plain text',
      },
      {
        keys: 'Delete / Backspace',
        description: 'Delete selected nodes or edges',
      },
    ],
  },
  {
    title: 'Layout',
    items: [
      { keys: 'Ctrl/Cmd+Plus', description: 'Zoom in' },
      { keys: 'Ctrl/Cmd+Minus', description: 'Zoom out' },
    ],
  },
  {
    title: 'Toolbar',
    items: [
      { keys: 'Space (hold)', description: 'Temporarily switch to pan tool' },
      {
        keys: 'Space (hold while dragging)',
        description:
          'Move a node without entering or leaving any frame (opt out of auto-reparent)',
      },
      { keys: 'S', description: 'Select tool' },
      { keys: 'P', description: 'Pan tool' },
      { keys: 'L', description: 'Lasso tool' },
      { keys: '3', description: 'Frame placement mode' },
      { keys: '1', description: 'Note placement mode' },
      { keys: '2', description: 'Text placement mode' },
      { keys: '4', description: 'Sketch mode' },
      { keys: '5', description: 'Audio placement mode' },
      { keys: 'A', description: 'Create Agent Node' },
    ],
  },
  {
    title: 'Layering & Grouping',
    items: [
      { keys: '[', description: 'Send selected nodes to back' },
      { keys: ']', description: 'Bring selected nodes to front' },
      { keys: 'Ctrl/Cmd+G', description: 'Group selected nodes into a frame' },
    ],
  },
  {
    title: 'Drag and drop',
    items: [
      {
        keys: 'Option (hold while dragging) / Ctrl (hold while dragging)',
        description:
          'Copy a Note block to the Space instead of moving it (the default is move — the source loses the block)',
      },
    ],
  },
  {
    title: 'Search',
    items: [
      {
        keys: 'Ctrl/Cmd+F',
        description:
          'Search the Space (or find inside the active preview when focus is in an expanded node)',
      },
      { keys: 'Enter', description: 'Jump to active result / next match' },
      { keys: 'Shift+Enter', description: 'Previous match (in preview)' },
      {
        keys: '↑ / ↓',
        description: 'Move between results (in Space overlay)',
      },
      { keys: 'Esc', description: 'Close the search bar' },
    ],
  },
  {
    title: 'Help',
    items: [
      { keys: '?', description: 'Show keyboard shortcuts' },
      { keys: 'Esc', description: 'Close the shortcuts dialog' },
    ],
  },
];
