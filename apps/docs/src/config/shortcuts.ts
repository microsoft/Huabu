export type ShortcutSection = {
  title: string;
  items: Array<{ keys: string; description: string }>;
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
        description: 'Move a node without entering or leaving any frame',
      },
      { keys: 'S', description: 'Select tool' },
      { keys: 'P', description: 'Pan tool' },
      { keys: 'L', description: 'Lasso tool' },
      { keys: '1', description: 'Frame placement mode' },
      { keys: '2', description: 'Note placement mode' },
      { keys: '3', description: 'Text placement mode' },
      { keys: '4', description: 'Sketch mode' },
      { keys: '5', description: 'Audio placement mode' },
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
        keys: 'Option / Ctrl (hold while dragging)',
        description: 'Copy a Note block to the canvas instead of moving it',
      },
    ],
  },
  {
    title: 'AI',
    items: [
      { keys: 'Ctrl/Cmd+I', description: 'Open intent recognition' },
      {
        keys: 'Shift+Enter',
        description: 'Submit a Question node and run immediately',
      },
    ],
  },
  {
    title: 'Search',
    items: [
      { keys: 'Ctrl/Cmd+F', description: 'Search the canvas' },
      { keys: 'Enter', description: 'Jump to active result or next match' },
      { keys: 'Shift+Enter', description: 'Previous match in preview' },
      { keys: '↑ / ↓', description: 'Move between canvas search results' },
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
