export type ShortcutItem = {
  keys: string;
  description: string;
};

export type ShortcutSection = {
  title: string;
  items: ShortcutItem[];
};

export const keyboardShortcutSections: ShortcutSection[] = [
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
      { keys: '1', description: 'Frame placement mode' },
      { keys: '2', description: 'Note placement mode' },
      { keys: '3', description: 'Text placement mode' },
      { keys: '4', description: 'Sketch mode' },
      { keys: 'Q', description: 'Question Sticker placement mode' },
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
        keys: 'Ctrl/Cmd (hold while dragging)',
        description:
          'Copy a Note block to the canvas instead of moving it (the default is move — the source loses the block)',
      },
    ],
  },
  {
    title: 'AI',
    items: [
      { keys: 'Ctrl/Cmd+I', description: 'Open intent recognition' },
      {
        keys: 'Shift+Enter',
        description:
          'Submit a Question node and run immediately (while editing)',
      },
    ],
  },
  {
    title: 'Search',
    items: [
      {
        keys: 'Ctrl/Cmd+F',
        description:
          'Search the canvas (or find inside the active preview when focus is in an expanded node)',
      },
      { keys: 'Enter', description: 'Jump to active result / next match' },
      { keys: 'Shift+Enter', description: 'Previous match (in preview)' },
      {
        keys: '↑ / ↓',
        description: 'Move between results (in canvas overlay)',
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
