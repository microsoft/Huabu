// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';

import { createMilkdown, type MilkdownInstance } from '../createMilkdown';

let instances: MilkdownInstance[] = [];
let roots: HTMLElement[] = [];

async function mount(markdown: string): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  const instance = await createMilkdown({
    root,
    initialMarkdown: markdown,
    toolbarMode: 'none',
  });
  instances.push(instance);
  return root;
}

afterEach(async () => {
  await Promise.all(instances.map((instance) => instance.destroy()));
  for (const root of roots) root.remove();
  instances = [];
  roots = [];
});

describe('Milkdown color marks', () => {
  it('parses persisted text-color spans as styled text instead of source text', async () => {
    const root = await mount(
      '1. <span data-sediment-text-color="orange" style="color: color-mix(in srgb, #D89A5B 60%, var(--fg-default))">字prompt</span>\n',
    );

    expect(root.textContent).toContain('字prompt');
    expect(root.textContent).not.toContain('data-sediment-text-color');
    expect(
      root.querySelector('span[data-sediment-text-color="orange"]'),
    ).not.toBeNull();
  });

  it('parses persisted background-color spans as styled text instead of source text', async () => {
    const root = await mount(
      '1. <span data-sediment-background-color="blue" style="background-color: color-mix(in srgb, #5F8F9B 25%, transparent)">字prompt</span>\n',
    );

    expect(root.textContent).toContain('字prompt');
    expect(root.textContent).not.toContain('data-sediment-background-color');
    expect(
      root.querySelector('span[data-sediment-background-color="blue"]'),
    ).not.toBeNull();
  });
});
