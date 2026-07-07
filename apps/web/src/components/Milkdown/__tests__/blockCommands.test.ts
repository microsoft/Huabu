// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';

import { createMilkdown, type MilkdownInstance } from '../createMilkdown';

let instances: MilkdownInstance[] = [];
let roots: HTMLElement[] = [];

async function mount(markdown: string): Promise<MilkdownInstance> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  const instance = await createMilkdown({
    root,
    initialMarkdown: markdown,
    toolbarMode: 'none',
  });
  instances.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(instances.map((instance) => instance.destroy()));
  for (const root of roots) root.remove();
  instances = [];
  roots = [];
});

describe('Milkdown block commands', () => {
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
    instance.setLink('https://sediment.dev', activeLink?.range);

    expect(activeLink?.href).toBe('https://example.com');
    expect(instance.getMarkdown()).toContain('[hello](https://sediment.dev)');
    expect(instance.getMarkdown()).not.toContain('https://example.com');
  });

  it('applies a link to a saved text range after selection focus changes', async () => {
    const instance = await mount('hello');

    instance.__selectAllTextForTest?.();
    const range = instance.getSelectionRange();
    instance.__selectCurrentBlockForTest?.();
    instance.setLink('https://sediment.dev', range);

    expect(instance.getMarkdown()).toContain('[hello](https://sediment.dev)');
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

  it('indents and outdents bullet list items with Tab', async () => {
    const instance = await mount('- first\n- second');

    instance.__setCursorAfterTextForTest?.('second');
    instance.__dispatchKeyDownForTest?.('Tab');

    expect(instance.getMarkdown()).toContain('  * second');

    instance.__dispatchKeyDownForTest?.('Tab', true);

    expect(instance.getMarkdown()).toContain('* second');
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
});
