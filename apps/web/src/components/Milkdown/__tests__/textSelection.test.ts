// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it } from 'vitest';

import { markdownSearchTarget } from '@huabu/shared/canvas-engine';

import { createMilkdown, type MilkdownInstance } from '../createMilkdown';

let instance: MilkdownInstance | undefined;
let root: HTMLDivElement | undefined;

afterEach(async () => {
  await instance?.destroy();
  root?.remove();
});

async function mount(markdown: string) {
  root = document.createElement('div');
  document.body.appendChild(root);
  instance = await createMilkdown({
    root,
    initialMarkdown: markdown,
    editable: true,
    previewMode: true,
    toolbarMode: 'none',
  });
  return instance;
}

describe('Milkdown text selection snapshots', () => {
  it('resolves a search source after a code node without counting node-view chrome or moving selection', async () => {
    const source = '```txt\nunrelated code\n```\n\nParagraph needle';
    const editor = await mount(source);
    const target = markdownSearchTarget(
      source,
      source.lastIndexOf('needle'),
      6,
    );
    if (!target) throw new Error('Missing source projection');
    const before = editor.getSelectionRange();
    const range = editor.getSearchRange(target.text, target.start, target.end);
    expect(range?.toString()).toBe('needle');
    expect(range?.startContainer.parentElement?.closest('p')?.textContent).toBe(
      'Paragraph needle',
    );
    expect(editor.getSelectionRange()).toEqual(before);
    expect(editor.getSearchRange('changed needle', 8, 14)).toBeNull();
  });
  it('captures inline formatted text with its actual range and neighboring context', async () => {
    const editor = await mount('Before **selected** after.');
    editor.__selectTextBetweenForTest?.('selected', 'selected');
    expect(editor.getTextSelection()).toMatchObject({
      text: 'selected',
      markdown: '**selected**\n',
      contextBefore: 'Before ',
      contextAfter: ' after.',
    });
    expect(editor.getTextSelection()?.range).toEqual(
      editor.getSelectionRange(),
    );
    expect(editor.getMarkdown()).toContain('**selected**');
  });

  it.each([
    ['Before **selected** after.', 'lect', 'lect', '**lect**'],
    [
      'Before [selected](https://example.com) after.',
      'lect',
      'lect',
      '[lect](https://example.com)',
    ],
    [
      '- First item\n- Second **item**\n- Third item\n\nEnd.',
      'Second',
      'item',
      '* Second **item**',
    ],
    [
      '```ts\nconst first = 1;\nconst second = 2;\n```\n\nEnd.',
      'const second',
      '2;',
      '```ts\nconst second = 2;\n```',
    ],
  ])(
    'serializes only the selected Markdown in %s',
    async (source, from, to, expected) => {
      const editor = await mount(source);
      const original = editor.getMarkdown();
      editor.__selectTextBetweenForTest?.(from, to);
      expect(editor.getTextSelection()?.markdown).toBe(`${expected}\n`);
      expect(editor.getMarkdown()).toBe(original);
    },
  );

  it('preserves cross-paragraph Markdown without including unselected boundary text', async () => {
    const editor = await mount(
      'Before **first**.\n\nSecond [link](https://example.com) after.',
    );
    editor.__selectTextBetweenForTest?.('first', 'link');
    expect(editor.getTextSelection()?.markdown).toBe(
      '**first**.\n\nSecond [link](https://example.com)\n',
    );
  });

  it('preserves paragraph breaks and code line breaks without mutating the answer', async () => {
    const editor = await mount(
      'First paragraph.\n\nSecond paragraph.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nEnd.',
    );
    const original = editor.getMarkdown();
    editor.__selectTextBetweenForTest?.('First paragraph.', 'const b = 2;');
    expect(editor.getTextSelection()?.text).toBe(
      'First paragraph.\n\nSecond paragraph.\n\nconst a = 1;\nconst b = 2;',
    );
    expect(editor.getMarkdown()).toBe(original);
  });

  it('distinguishes a repeated quote by range and surrounding text', async () => {
    const editor = await mount('first same\n\nsecond same');
    editor.__selectTextBetweenForTest?.('second same', 'second same');
    expect(editor.getTextSelection()?.text).toBe('second same');
    expect(editor.getTextSelection()?.contextBefore).toContain('first same');
  });

  it('preserves explicit line breaks within a paragraph', async () => {
    const editor = await mount('First line.  \nSecond line.');
    editor.__selectAllTextForTest?.();
    expect(editor.getTextSelection()?.text).toBe('First line.\nSecond line.');
  });

  it('captures Unicode and rejects collapsed and block-node selections', async () => {
    const editor = await mount('你好 👋 world.');
    editor.__selectAllTextForTest?.();
    expect(editor.getTextSelection()?.text).toBe('你好 👋 world.');
    editor.__setCursorAfterTextForTest?.('你好');
    expect(editor.getTextSelection()).toBeNull();
    editor.__selectCurrentBlockForTest?.();
    expect(editor.getTextSelection()).toBeNull();
  });
});
