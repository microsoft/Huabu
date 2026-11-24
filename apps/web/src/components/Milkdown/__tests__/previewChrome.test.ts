// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMilkdown, type MilkdownInstance } from '../createMilkdown';

let instance: MilkdownInstance | undefined;
let root: HTMLDivElement | undefined;

afterEach(async () => {
  await instance?.destroy();
  root?.remove();
  instance = undefined;
  root = undefined;
});

describe('Milkdown read-only chrome', () => {
  it('omits link-edit controls without dropping table rendering', async () => {
    root = document.createElement('div');
    document.body.appendChild(root);

    instance = await createMilkdown({
      root,
      initialMarkdown: `A [link](https://example.com).

| A | B |
| --- | --- |
| hello | world |`,
      editable: false,
      toolbarMode: 'none',
    });

    expect(root.querySelector('input.input-area')).toBeNull();
    expect(root.querySelector('.milkdown-table-block')).not.toBeNull();
    expect(instance.getMarkdown()).toContain('[link](https://example.com)');
  });

  it('renders single-file tables and code without image resources, HTML execution or navigable links', async () => {
    root = document.createElement('div');
    document.body.appendChild(root);
    const resolveImageSrc = vi.fn((src: string) => src);
    instance = await createMilkdown({
      root,
      editable: false,
      toolbarMode: 'none',
      singleFile: true,
      resolveImageSrc,
      initialMarkdown: [
        '| A | B |',
        '| --- | --- |',
        '| hello | world |',
        '',
        '```python',
        'print("hello")',
        '```',
        '',
        '[relative](../other.md) [remote](https://example.com) [unsafe](javascript:alert(1))',
        '![local](./image.png) ![remote image](https://example.com/image.png)',
        '<script>alert(1)</script><iframe src="https://example.com"></iframe>',
      ].join('\n'),
    });
    expect(root.querySelector('.milkdown-table-block')).not.toBeNull();
    expect(root.textContent).toContain('print("hello")');
    expect(root.textContent).toContain('[local]');
    // ProseMirror's own empty separator <img> carries no resource.
    const resources =
      'img:not(.ProseMirror-separator), a[href], iframe, script';
    expect(root.querySelector(resources)).toBeNull();
    expect(root.querySelector('img[src]')).toBeNull();
    expect(resolveImageSrc).not.toHaveBeenCalled();
    instance.setMarkdown(
      '![replacement](https://example.com/next.png) [link](https://example.com)',
    );
    expect(root.querySelector(resources)).toBeNull();
    expect(root.querySelector('img[src]')).toBeNull();
    expect(root.textContent).toContain('[replacement]');
    expect(resolveImageSrc).not.toHaveBeenCalled();
  });
});
