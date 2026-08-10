// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';

import { createMilkdown, type MilkdownInstance } from '../createMilkdown';

let instances: MilkdownInstance[] = [];
let roots: HTMLElement[] = [];

async function mount(
  markdown: string,
): Promise<{ instance: MilkdownInstance; root: HTMLElement }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  const instance = await createMilkdown({
    root,
    initialMarkdown: markdown,
    toolbarMode: 'none',
  });
  instances.push(instance);
  return { instance, root };
}

afterEach(async () => {
  await Promise.all(instances.map((instance) => instance.destroy()));
  for (const root of roots) root.remove();
  instances = [];
  roots = [];
});

describe('Milkdown color marks', () => {
  it('parses persisted text-color spans as styled text instead of source text', async () => {
    const { root } = await mount(
      '1. <span data-huabu-text-color="orange" style="color: color-mix(in srgb, #D89A5B 60%, var(--fg-default))">字prompt</span>\n',
    );

    expect(root.textContent).toContain('字prompt');
    expect(root.textContent).not.toContain('data-huabu-text-color');
    expect(
      root.querySelector('span[data-huabu-text-color="orange"]'),
    ).not.toBeNull();
  });

  it('parses persisted background-color spans as styled text instead of source text', async () => {
    const { root } = await mount(
      '1. <span data-huabu-background-color="blue" style="background-color: color-mix(in srgb, #5F8F9B 25%, transparent)">字prompt</span>\n',
    );

    expect(root.textContent).toContain('字prompt');
    expect(root.textContent).not.toContain('data-huabu-background-color');
    expect(
      root.querySelector('span[data-huabu-background-color="blue"]'),
    ).not.toBeNull();
  });

  it('migrates persisted Sediment background-color spans', async () => {
    const { instance, root } = await mount(
      '<span data-sediment-background-color="purple" style="background-color: color-mix(in srgb, #9B8AC4 25%, transparent)">Highlighted text</span>',
    );

    expect(root.textContent).toContain('Highlighted text');
    expect(root.textContent).not.toContain('data-sediment-background-color');
    expect(
      root.querySelector('span[data-huabu-background-color="purple"]'),
    ).not.toBeNull();
    expect(instance.getMarkdown()).toContain(
      'data-huabu-background-color="purple"',
    );
    expect(instance.getMarkdown()).not.toContain('data-sediment');
  });

  it('round-trips color marks with nested inline marks', async () => {
    const { instance } = await mount('hello');

    instance.__selectAllTextForTest?.();
    instance.toggleMark('bold');
    instance.setTextColor('orange');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('data-huabu-text-color="orange"');

    const { root } = await mount(markdown);
    expect(root.querySelector('strong')).not.toBeNull();
    expect(
      root.querySelector('span[data-huabu-text-color="orange"]'),
    ).not.toBeNull();
  });

  it('keeps indented fragment content out of a code block when inserted', async () => {
    const span =
      '<span data-huabu-background-color="purple" style="background-color: color-mix(in srgb, #9B8AC4 25%, transparent)">Highlighted text</span>';
    const { instance, root } = await mount('intro\n');

    // Markdown extracted from a nested list item carries its indentation.
    instance.insertBlocksAfter(null, `    ${span}`);

    expect(root.querySelector('.milkdown-code-block')).toBeNull();
    expect(
      root.querySelector('span[data-huabu-background-color="purple"]'),
    ).not.toBeNull();
    expect(instance.getMarkdown()).not.toContain('```');
  });

  it('round-trips overlapping text and background color marks', async () => {
    const { instance } = await mount('hello');

    instance.__selectAllTextForTest?.();
    instance.setTextColor('orange');
    instance.__selectAllTextForTest?.();
    instance.setBackgroundColor('blue');
    instance.__selectAllTextForTest?.();

    expect(instance.getFormattingState().textColor).toBe('orange');
    expect(instance.getFormattingState().backgroundColor).toBe('blue');

    const markdown = instance.getMarkdown();
    expect(markdown).toContain('data-huabu-text-color="orange"');
    expect(markdown).toContain('data-huabu-background-color="blue"');

    const { root } = await mount(markdown);
    expect(
      root.querySelector('span[data-huabu-text-color="orange"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('span[data-huabu-background-color="blue"]'),
    ).not.toBeNull();
    expect(root.textContent).toContain('hello');
    expect(root.textContent).not.toContain('data-huabu');
  });
});
