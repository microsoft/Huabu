// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';

import { fingerprintMarkdownKeys } from '@huabu/shared/canvas-engine';

import { createMilkdown, type MilkdownInstance } from '../createMilkdown';

const prose = String.raw`\keypoint{Automated trace-driven optimization uses traces to propose
changes but relies on task-level evaluation to establish their value.}
However, execution traces alone do not establish whether a proposed
change improves efficiency without compromising task performance.`;

const instances: MilkdownInstance[] = [];
const roots: HTMLElement[] = [];

async function mount(markdown: string, previewMode = true) {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const instance = await createMilkdown({
    root,
    initialMarkdown: markdown,
    previewMode,
    toolbarMode: 'none',
  });
  instances.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.destroy()));
  roots.splice(0).forEach((root) => root.remove());
});

describe('LaTeX source fences versus explicit math', () => {
  it.each(['latex', 'LaTeX', 'LATEX', 'tex'])(
    'retains %s document source and its fence language through serialization',
    async (language) => {
      const source = `Before **bold**.\n\n\`\`\`${language}\n${prose}\n\`\`\`\n\nAfter.`;
      const instance = await mount(source);
      const serialized = instance.getMarkdown();
      expect(serialized).toContain(`\`\`\`${language}\n${prose}\n\`\`\``);
      expect(serialized).not.toContain('$$');
      expect(fingerprintMarkdownKeys(serialized)).toEqual(
        fingerprintMarkdownKeys(source),
      );
      instance.setMarkdown(serialized);
      expect(instance.getMarkdown()).toBe(serialized);
    },
  );

  it('keeps formulas and math delimiters inside a source fence literal', async () => {
    const body = String.raw`\frac{a}{b}
$x$ and $$y$$ and \(z\) and \[w\]`;
    const instance = await mount(`\`\`\`latex\n${body}\n\`\`\``);
    expect(instance.getMarkdown()).toContain(`\`\`\`latex\n${body}\n\`\`\``);
  });

  it('preserves nested and tilde-fenced source blocks', async () => {
    const instance = await mount(
      `> \`\`\`LaTeX\n> ${prose.split('\n')[0]}\n> \`\`\`\n\n~~~latex\n${prose}\n~~~`,
    );
    const serialized = instance.getMarkdown();
    expect(serialized).toContain('> ```LaTeX');
    expect(serialized).toContain(`\`\`\`latex\n${prose}`);
    expect(serialized).not.toContain('$$');
  });

  it('uses the same source behavior on initial, streaming and completed updates', async () => {
    const instance = await mount('Before.');
    for (const body of ['', '\\frac{a}{', '\\frac{a}{b}', prose]) {
      instance.setMarkdown(`Before.\n\n\`\`\`latex\n${body}`);
      expect(instance.getMarkdown()).toContain('```latex');
      expect(instance.getMarkdown()).not.toContain('$$');
    }
    instance.setMarkdown(`Before.\n\n\`\`\`latex\n${prose}\n\`\`\`\n\nAfter.`);
    expect(instance.getMarkdown()).toContain(prose);
    expect(instance.getMarkdown()).toContain('After.');
  });

  it('exports source rather than math for dragged blocks and selected fragments', async () => {
    const instance = await mount(`\`\`\`LaTeX\n${prose}\n\`\`\``);
    instance.__selectCurrentBlockForTest?.();
    expect(instance.getDragPayload()?.markdown).toContain(
      `\`\`\`LaTeX\n${prose}\n\`\`\``,
    );
    instance.__selectTextBetweenForTest?.('However', 'performance.');
    expect(instance.getTextSelection()?.markdown).toContain('```LaTeX');
    expect(instance.getTextSelection()?.markdown).not.toContain('$$');
  });

  it('does not reinterpret latex syntax inside an ordinary outer code block', async () => {
    const source =
      '````markdown\n```latex\n\\keypoint{Literal example}\n```\n````';
    const instance = await mount(source);
    expect(instance.getMarkdown()).toContain(source);
  });

  it('preserves explicit inline and display math outside fences', async () => {
    const source = String.raw`Inline $x$ and \(y\).

$$
\frac{a}{b}
$$

\[z^2\]`;
    const instance = await mount(source);
    const serialized = instance.getMarkdown();
    expect(serialized).toContain('$x$');
    expect(serialized).toContain('$y$');
    expect(serialized).toContain('$$\n\\frac{a}{b}\n$$');
    expect(serialized).toContain('$$\nz^2\n$$');
    expect(serialized).not.toContain('```');
  });

  it('keeps Note parsing and explicit Math commands consistent', async () => {
    const instance = await mount(`\`\`\`latex\n${prose}\n\`\`\``, false);
    expect(instance.getFormattingState().blockType).toBe('code-block');
    expect(instance.getMarkdown()).toContain('```latex');
    instance.setMarkdown('x');
    instance.setBlockType('math');
    expect(instance.getMarkdown()).toContain('$$\nx\n$$');
    expect(instance.getFormattingState().blockType).toBe('math');
    instance.setMarkdown(instance.getMarkdown());
    expect(instance.getFormattingState().blockType).toBe('math');
  });
});
