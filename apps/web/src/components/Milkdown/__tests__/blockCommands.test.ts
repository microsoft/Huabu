// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMac } from '@/utils/platform';

import { createMilkdown, type MilkdownInstance } from '../createMilkdown';

let instances: MilkdownInstance[] = [];
let roots: HTMLElement[] = [];

async function mount(
  markdown: string,
  overrides?: { editable?: boolean },
): Promise<MilkdownInstance> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  const instance = await createMilkdown({
    root,
    initialMarkdown: markdown,
    toolbarMode: 'none',
    ...overrides,
  });
  instances.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(instances.map((instance) => instance.destroy()));
  for (const root of roots) root.remove();
  instances = [];
  roots = [];
  vi.restoreAllMocks();
});

function editorSurface(): Element {
  const surface = document.querySelector('.milkdown .ProseMirror');
  if (!surface) throw new Error('Editor surface not mounted');
  return surface;
}

/**
 * Give the editor DOM a synthetic vertical layout.
 *
 * happy-dom performs no layout, so every rect is zero-sized and
 * `prosemirror-drop-indicator` — which picks its target purely by
 * distance from the pointer to each block's top / bottom edge — has
 * nothing to measure. Stack leaf elements one row apart and let each
 * ancestor span its children.
 */
function stubBlockLayout(rowHeight = 20): void {
  const rects = new Map<Element, DOMRect>();
  let row = 0;
  const assign = (el: Element): void => {
    const start = row;
    const children = Array.from(el.children);
    if (children.length === 0) row += 1;
    else children.forEach(assign);
    const top = start * rowHeight;
    const bottom = Math.max(row, start + 1) * rowHeight;
    rects.set(el, {
      x: 0,
      y: top,
      left: 0,
      right: 100,
      width: 100,
      top,
      bottom,
      height: bottom - top,
      toJSON: () => ({}),
    });
  };
  assign(editorSurface());
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      return (
        rects.get(this) ??
        ({
          x: 0,
          y: 0,
          left: 0,
          right: 0,
          width: 0,
          top: 0,
          bottom: 0,
          height: 0,
          toJSON: () => ({}),
        } as DOMRect)
      );
    },
  );
}

/** Show the drop indicator at `y` (x = 0 keeps the match vertical). */
function dragOverAt(y: number): void {
  editorSurface().dispatchEvent(
    new MouseEvent('dragover', { bubbles: true, clientX: 0, clientY: y }),
  );
}

/** Bottom edge of a rendered block, per {@link stubBlockLayout}. */
function bottomOf(selector: string, index = 0): number {
  const el = document.querySelectorAll(`.milkdown ${selector}`)[index];
  if (!el) throw new Error(`No element matching ${selector}[${index}]`);
  return el.getBoundingClientRect().bottom;
}

const NESTED_LIST = '- a\n  - b\n  - c\n- d\n\ntail';

function clickLink(options: { modifier: boolean; href?: string }): MouseEvent {
  const anchor = document.querySelector('.milkdown a[href]');
  if (!anchor) throw new Error('Expected a rendered link');
  if (options.href !== undefined) anchor.setAttribute('href', options.href);
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...(options.modifier
      ? isMac
        ? { metaKey: true }
        : { ctrlKey: true }
      : {}),
  });
  anchor.dispatchEvent(event);
  return event;
}

describe('Milkdown block commands', () => {
  it('portals each drop indicator outside transformed editor hosts', async () => {
    await mount('first');
    await mount('second');

    const indicators = Array.from(document.body.children).filter((child) =>
      child.classList.contains('milkdown-drop-indicator'),
    );
    expect(indicators).toHaveLength(2);
    expect(
      roots.some((root) => root.querySelector('.milkdown-drop-indicator')),
    ).toBe(false);
  });

  it('prepares a complete native move for partially selected blocks', async () => {
    const instance = await mount(
      'first paragraph\n\nsecond paragraph\n\nthird paragraph',
    );

    instance.__selectTextBetweenForTest?.('paragraph', 'third');
    const originalSelection = instance.getSelectionRange();
    const dragRange = instance.getMultiBlockSelectionRange();

    expect(dragRange).not.toBeNull();
    if (!dragRange) throw new Error('Expected a multi-block drag range');
    expect(originalSelection).not.toEqual(dragRange);

    instance.setDragSelection(dragRange);
    instance.setDraggingSlice(dragRange);

    expect(instance.getSelectionRange()).toEqual(dragRange);
    const expectedMarkdown =
      'first paragraph\n\nsecond paragraph\n\nthird paragraph';
    expect(instance.getDragPayload(dragRange)?.markdown.trim()).toBe(
      expectedMarkdown,
    );
    expect(instance.__getDraggingMarkdownForTest?.()?.trim()).toBe(
      expectedMarkdown,
    );

    instance.clearDraggingSlice();
    expect(instance.__getDraggingMarkdownForTest?.()).toBeNull();
  });

  it('converts every block of a multi-paragraph selection to a list', async () => {
    const instance = await mount(
      'first paragraph\n\nsecond paragraph\n\nthird paragraph',
    );

    instance.__selectTextBetweenForTest?.('first', 'third');
    instance.setBlockType('bullet-list');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('first paragraph');
    expect(markdown).toContain('second paragraph');
    expect(markdown).toContain('third paragraph');
    expect(markdown.match(/^\s*[-*]\s/gm)?.length).toBe(3);
  });

  it('converts every block of a multi-paragraph selection to a heading', async () => {
    const instance = await mount('first paragraph\n\nsecond paragraph');

    instance.__selectTextBetweenForTest?.('first', 'second');
    instance.setBlockType('heading-2');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('## first paragraph');
    expect(markdown).toContain('## second paragraph');
  });

  it('preserves inline marks when converting several blocks to a list', async () => {
    const instance = await mount('**bold** one\n\n[link](https://example.com)');

    instance.__selectTextBetweenForTest?.('bold', 'link');
    instance.setBlockType('bullet-list');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('**bold**');
    expect(markdown).toContain('[link](https://example.com)');
    expect(markdown.match(/^\s*[-*]\s/gm)?.length).toBe(2);
  });

  it('applies and clears a link without using prompt', async () => {
    const instance = await mount('hello');

    instance.__selectAllTextForTest?.();
    instance.setLink('https://example.com');

    expect(instance.getMarkdown()).toContain('[hello](https://example.com)');

    instance.__selectAllTextForTest?.();
    instance.setLink(null);

    expect(instance.getMarkdown()).toContain('hello');
    expect(instance.getMarkdown()).not.toContain('https://example.com');
  });

  it('rejects unsafe link schemes', async () => {
    const instance = await mount('hello');

    instance.__selectAllTextForTest?.();
    instance.setLink('javascript:alert(1)');

    expect(instance.getMarkdown()).toContain('hello');
    expect(instance.getMarkdown()).not.toContain('javascript:');
  });

  it('reads and updates an active link', async () => {
    const instance = await mount('[hello](https://example.com)');

    instance.__selectAllTextForTest?.();
    const activeLink = instance.getActiveLink();
    instance.setLink('https://huabu.dev', activeLink?.range);

    expect(activeLink?.href).toBe('https://example.com');
    expect(instance.getMarkdown()).toContain('[hello](https://huabu.dev)');
    expect(instance.getMarkdown()).not.toContain('https://example.com');
  });

  it('applies a link to a saved text range after selection focus changes', async () => {
    const instance = await mount('hello');

    instance.__selectAllTextForTest?.();
    const range = instance.getSelectionRange();
    instance.__selectCurrentBlockForTest?.();
    instance.setLink('https://huabu.dev', range);

    expect(instance.getMarkdown()).toContain('[hello](https://huabu.dev)');
  });

  it('inserts the URL as linked text when applying a link without a text selection', async () => {
    const instance = await mount('hello');

    instance.setLink('https://example.com');

    expect(instance.getMarkdown()).toContain('<https://example.com>');
  });

  it('inserts a link inside the current node-selected block', async () => {
    const instance = await mount('hello\n\nworld');

    instance.__selectCurrentBlockForTest?.();
    instance.setLink('https://example.com');

    expect(instance.getMarkdown()).toContain('hello<https://example.com>');
    expect(instance.getMarkdown()).toContain('\n\nworld');
  });

  it('wraps selected text as inline math', async () => {
    const instance = await mount('hello');

    instance.__selectAllTextForTest?.();
    instance.insertInlineMath();

    expect(instance.getMarkdown()).toContain('$hello$');
  });

  it('inserts an inline math scaffold without a text selection', async () => {
    const instance = await mount('hello');

    instance.insertInlineMath();

    expect(instance.getMarkdown()).toContain('$x$');
  });

  it('updates an active inline math node', async () => {
    const instance = await mount('hello');

    instance.insertInlineMath();
    const activeMath = instance.getActiveInlineMath();
    instance.setInlineMath('x + y', activeMath?.range);

    expect(activeMath?.value).toBe('x');
    expect(instance.getMarkdown()).toContain('$x + y$');
  });

  it('converts the current block to a bullet list', async () => {
    const instance = await mount('hello');

    instance.setBlockType('bullet-list');

    expect(instance.getMarkdown()).toContain('* hello');
  });

  it('converts the current block to an ordered list', async () => {
    const instance = await mount('hello');

    instance.setBlockType('ordered-list');

    expect(instance.getMarkdown()).toContain('1. hello');
  });

  it('converts the current block to a task list', async () => {
    const instance = await mount('hello');

    instance.setBlockType('task-list');

    expect(instance.getMarkdown()).toContain('* [ ] hello');
  });

  it('converts only the current nested list item to a bullet list', async () => {
    const instance = await mount(`# Update

1. huabu agent

   1. layout
2. sync`);

    instance.__setCursorAfterTextForTest?.('layout');
    instance.setBlockType('bullet-list');

    expect(instance.getMarkdown()).toContain('   * layout');
    expect(instance.getMarkdown()).toContain('2. sync');
  });

  it('converts only a node-selected nested list item to a bullet list', async () => {
    const instance = await mount(`# Update

1. huabu agent

   1. layout
2. sync`);

    instance.__selectListItemContainingTextForTest?.('layout');
    instance.setBlockType('bullet-list');

    expect(instance.getMarkdown()).toContain('1. huabu agent');
    expect(instance.getMarkdown()).toContain('   * layout');
    expect(instance.getMarkdown()).toContain('2. sync');
  });

  it('converts a node-selected nested list item to a paragraph without merging its parent', async () => {
    const instance = await mount('- A\n  - B');

    instance.__selectListItemContainingTextForTest?.('B');
    instance.setBlockType('paragraph');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('* A');
    expect(markdown).not.toContain('A B');
  });

  it('converts a node-selected top-level list item to a paragraph without merging siblings', async () => {
    const instance = await mount('- A\n- B');

    instance.__selectListItemContainingTextForTest?.('A');
    instance.setBlockType('paragraph');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('* B');
    expect(markdown).not.toContain('A B');
  });

  it('converts a block-handle-selected nested list to bullets without merging rows', async () => {
    const instance = await mount('# Update\n\n1. huabu agent\n   1. layout\n');

    // Simulate the drag-handle selecting the whole enclosing top-level list.
    instance.__setCursorAfterTextForTest?.('layout');
    instance.__selectCurrentBlockForTest?.();
    instance.setBlockType('bullet-list');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('* huabu agent');
    expect(markdown).toContain('  * layout');
    expect(markdown).not.toContain('huabu agent layout');
  });

  it('converts a block-handle-selected nested list to a task list', async () => {
    const instance = await mount('- huabu agent\n  - layout\n');

    instance.__setCursorAfterTextForTest?.('layout');
    instance.__selectCurrentBlockForTest?.();
    instance.setBlockType('task-list');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('* [ ] huabu agent');
    expect(markdown).toContain('  * [ ] layout');
  });

  it('converts a list item that has a nested child without merging its rows', async () => {
    const instance = await mount('- parent\n  - layout\n');

    instance.__setCursorAfterTextForTest?.('parent');
    instance.setBlockType('ordered-list');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('1. parent');
    expect(markdown).toContain('   * layout');
    expect(markdown).not.toContain('parent layout');
  });

  it('converts a node-selected parent list item without merging its nested child', async () => {
    const instance = await mount('- parent\n  - layout\n');

    instance.__selectListItemContainingTextForTest?.('parent');
    instance.setBlockType('ordered-list');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('1. parent');
    expect(markdown).toContain('   * layout');
    expect(markdown).not.toContain('parent layout');
  });

  it('block-handle range on a nested child targets the child, not the parent', async () => {
    const instance = await mount('# Update\n\n1. huabu agent\n   1. layout\n');

    // The drag handle presents a nested item as a TextSelection spanning the
    // item at the enclosing list level (its `$from` resolves to the list).
    instance.__selectListItemAsRangeForTest?.('layout');
    instance.setBlockType('bullet-list');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('1. huabu agent');
    expect(markdown).toContain('   * layout');
    expect(markdown).not.toContain('* huabu agent');
  });

  it('indents and outdents bullet list items with Tab', async () => {
    const instance = await mount('- first\n- second');

    instance.__setCursorAfterTextForTest?.('second');
    instance.__dispatchKeyDownForTest?.('Tab');

    expect(instance.getMarkdown()).toContain('  * second');

    instance.__dispatchKeyDownForTest?.('Tab', true);

    expect(instance.getMarkdown()).toContain('* second');
  });

  it('indents a paragraph into the list above it with Tab', async () => {
    const instance = await mount('- first\n\nsecond');

    instance.__setCursorAfterTextForTest?.('second');
    instance.__dispatchKeyDownForTest?.('Tab');

    expect(instance.getMarkdown()).toContain('  * second');
  });

  it('opens a link in a new tab on modifier-click', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await mount('see [docs](https://example.com) here');

    const event = clickLink({ modifier: true });

    expect(open).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer',
    );
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a plain click on a link to the caret', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await mount('see [docs](https://example.com) here');

    clickLink({ modifier: false });

    expect(open).not.toHaveBeenCalled();
  });

  it('opens a link on modifier-click in a read-only surface', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await mount('see [docs](https://example.com) here', { editable: false });

    clickLink({ modifier: true });

    expect(open).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('refuses to open an unsafe link scheme on modifier-click', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await mount('see [docs](https://example.com) here');

    const event = clickLink({ modifier: true, href: 'javascript:alert(1)' });

    expect(open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('blocks a plain click on an unsafe link parsed from markdown', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await mount('see [docs](javascript:alert(1)) here');

    const event = clickLink({ modifier: false });

    expect(open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('nests several levels deep with repeated Tab', async () => {
    const instance = await mount('- a\n- b\n- c');

    instance.__setCursorAfterTextForTest?.('b');
    instance.__dispatchKeyDownForTest?.('Tab');
    instance.__setCursorAfterTextForTest?.('c');
    instance.__dispatchKeyDownForTest?.('Tab');
    instance.__dispatchKeyDownForTest?.('Tab');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('* a');
    expect(markdown).toContain('  * b');
    expect(markdown).toContain('    * c');
  });

  it('indents a paragraph into the ordered list above it with Tab', async () => {
    const instance = await mount('1. first\n\nsecond');

    instance.__setCursorAfterTextForTest?.('second');
    instance.__dispatchKeyDownForTest?.('Tab');

    expect(instance.getMarkdown()).toContain('   1. second');
  });

  it('indents a standalone paragraph into a top-level bullet with Tab', async () => {
    const instance = await mount('intro\n\nsecond');

    instance.__setCursorAfterTextForTest?.('second');
    instance.__dispatchKeyDownForTest?.('Tab');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('* second');
    expect(markdown).not.toContain('* intro');
  });

  it('returns an indented paragraph to plain text with Shift-Tab', async () => {
    const instance = await mount('intro\n\nsecond');

    instance.__setCursorAfterTextForTest?.('second');
    instance.__dispatchKeyDownForTest?.('Tab');
    expect(instance.getMarkdown()).toContain('* second');

    instance.__dispatchKeyDownForTest?.('Tab', true);

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('second');
    expect(markdown).not.toContain('* second');
  });

  it('keeps inline marks when Tab indents a paragraph', async () => {
    const instance = await mount('intro\n\n**bold** tail');

    instance.__setCursorAfterTextForTest?.('tail');
    instance.__dispatchKeyDownForTest?.('Tab');

    expect(instance.getMarkdown()).toContain('* **bold** tail');
  });

  it('leaves a code block a code block when Tab is pressed inside it', async () => {
    const instance = await mount('```\ncode line\n```\n');

    instance.__setCursorAfterTextForTest?.('code line');
    instance.__dispatchKeyDownForTest?.('Tab');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('```');
    expect(markdown).not.toContain('* code line');
  });

  it('replaces the current block with a valid table', async () => {
    const instance = await mount('hello');

    expect(() => instance.setBlockType('table')).not.toThrow();
    expect(instance.getMarkdown()).toContain('|');
  });

  it('converts a table to text', async () => {
    const instance = await mount(`| A | B |
| --- | --- |
| hello | world |`);

    instance.setBlockType('paragraph');

    expect(instance.getMarkdown()).toContain('A B hello world');
    expect(instance.getMarkdown()).not.toContain('|');
  });

  it('converts a table to a bullet list', async () => {
    const instance = await mount(`| A | B |
| --- | --- |
| hello | world |`);

    instance.setBlockType('bullet-list');

    expect(instance.getMarkdown()).toContain('* A B hello world');
    expect(instance.getMarkdown()).not.toContain('|');
  });

  it('converts a heading to a table', async () => {
    const instance = await mount('# hello');

    instance.setBlockType('table');

    expect(instance.getMarkdown()).toContain('|');
    expect(instance.getMarkdown()).not.toContain('# hello');
  });

  it('reports heading as the active block after a block-handle selection', async () => {
    const instance = await mount('# hello');

    instance.__selectCurrentBlockForTest?.();

    expect(instance.getFormattingState().blockType).toBe('heading-1');
  });

  it('converts a block-handle-selected heading to a table', async () => {
    const instance = await mount('# hello');

    instance.__selectCurrentBlockForTest?.();
    instance.setBlockType('table');

    expect(instance.getMarkdown()).toContain('|');
    expect(instance.getFormattingState().blockType).toBe('table');
  });

  it('converts a block-handle-selected heading to a task list', async () => {
    const instance = await mount('# hello');

    instance.__selectCurrentBlockForTest?.();
    instance.setBlockType('task-list');

    expect(instance.getMarkdown()).toContain('* [ ] hello');
    expect(instance.getFormattingState().blockType).toBe('task-list');
  });

  it.each([
    ['heading-2', '## A B hello world'],
    ['blockquote', '> A B hello world'],
    ['ordered-list', '1. A B hello world'],
    ['task-list', '* [ ] A B hello world'],
    ['code-block', '```\nA B hello world'],
    ['math', '$$\nA B hello world'],
    ['divider', '***'],
  ] as const)('converts a table to %s', async (blockType, expected) => {
    const instance = await mount(`| A | B |
| --- | --- |
| hello | world |`);

    instance.setBlockType(blockType);

    expect(instance.getMarkdown()).toContain(expected);
    expect(instance.getMarkdown()).not.toContain('|');
  });

  it.each([
    ['paragraph', 'hello'],
    ['heading', '# hello'],
    ['blockquote', '> hello'],
    ['bullet list', '- hello'],
    ['ordered list', '1. hello'],
    ['task list', '- [ ] hello'],
    ['code block', '```\nhello\n```'],
    ['math block', '```LaTeX\nhello\n```'],
  ] as const)('converts a %s to a table', async (_label, markdown) => {
    const instance = await mount(markdown);

    expect(() => instance.setBlockType('table')).not.toThrow();
    expect(instance.getMarkdown()).toContain('|');
  });

  it('inserts where the drop indicator points', async () => {
    const instance = await mount('# Introduction\n\nbody text');
    stubBlockLayout();
    dragOverAt(bottomOf('h1'));

    expect(instance.insertBlocksAtDropIndicator('**dropped**')).toBe(true);
    expect(instance.getMarkdown()).toBe(
      '# Introduction\n\n**dropped**\n\nbody text\n',
    );
  });

  it('inserts inside the list when the indicator points at a nested item', async () => {
    const instance = await mount(NESTED_LIST);
    stubBlockLayout();
    dragOverAt(bottomOf('li li'));

    expect(instance.insertBlocksAtDropIndicator('dropped')).toBe(true);
    expect(instance.getMarkdown()).toContain('* b\n\n    dropped\n\n  * c');
  });

  it('reports failure when no indicator is showing', async () => {
    const instance = await mount(NESTED_LIST);

    expect(instance.insertBlocksAtDropIndicator('dropped')).toBe(false);
    expect(instance.getMarkdown()).not.toContain('dropped');
  });
});
