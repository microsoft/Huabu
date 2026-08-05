// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';

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
});
