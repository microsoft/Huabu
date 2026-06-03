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
      {
        keys: 'Ctrl/Cmd+Shift+A',
        description: 'Toggle auto-layout mode',
      },
      { keys: 'Ctrl/Cmd+Plus', description: 'Zoom in' },
      { keys: 'Ctrl/Cmd+Minus', description: 'Zoom out' },
      { keys: 'Space (hold)', description: 'Temporarily switch to pan tool' },
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
    title: 'AI',
    items: [{ keys: 'Ctrl/Cmd+I', description: 'Open intent recognition' }],
  },
  {
    title: 'Help',
    items: [
      { keys: '?', description: 'Show keyboard shortcuts' },
      { keys: 'Esc', description: 'Close the shortcuts dialog' },
    ],
  },
];
