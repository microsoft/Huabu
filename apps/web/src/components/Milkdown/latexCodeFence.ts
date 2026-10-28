// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { nodeViewCtx, remarkPluginsCtx } from '@milkdown/core';
import { codeBlockSchema } from '@milkdown/preset-commonmark';
import { $view } from '@milkdown/utils';

import type { Ctx } from '@milkdown/ctx';

interface MarkdownNode {
  type: string;
  lang?: string | null;
  huabuSourceLanguage?: string;
  children?: MarkdownNode[];
}

function redirectLatexFences(node: MarkdownNode): void {
  if (node.type === 'code' && node.lang?.toLowerCase() === 'latex') {
    node.huabuSourceLanguage = node.lang;
    node.lang = 'tex';
  }
  node.children?.forEach(redirectLatexFences);
}

export function configureLatexCodeFences(ctx: Ctx): void {
  // Configuration runs before Crepe appends its math-to-code transform.
  ctx.update(remarkPluginsCtx, (plugins) => [
    { plugin: () => redirectLatexFences, options: {} },
    ...plugins,
  ]);
}

export const latexCodeBlockSchema = codeBlockSchema.extendSchema(
  (previous) => (ctx) => {
    const schema = previous(ctx);
    return {
      ...schema,
      attrs: {
        ...schema.attrs,
        sourceLanguage: { default: null },
      },
      parseMarkdown: {
        ...schema.parseMarkdown,
        runner: (state, node, type) => {
          if (typeof node.huabuSourceLanguage !== 'string') {
            return schema.parseMarkdown.runner(state, node, type);
          }
          state.openNode(type, {
            language: 'tex',
            sourceLanguage: node.huabuSourceLanguage,
          });
          if (typeof node.value === 'string' && node.value) {
            state.addText(node.value);
          }
          state.closeNode();
        },
      },
      toMarkdown: {
        ...schema.toMarkdown,
        runner: (state, node) => {
          if (
            node.attrs.language === 'tex' &&
            typeof node.attrs.sourceLanguage === 'string'
          ) {
            state.addNode('code', undefined, node.textContent, {
              lang: node.attrs.sourceLanguage,
            });
            return;
          }
          if (node.attrs.language.toLowerCase() === 'latex') {
            // Crepe uses internal LaTeX code nodes for explicit display math.
            state.addNode('math', undefined, node.textContent);
            return;
          }
          return schema.toMarkdown.runner(state, node);
        },
      },
    };
  },
);

export const readonlyCodeBlockView = $view(codeBlockSchema.node, (ctx) => {
  const original = ctx
    .get(nodeViewCtx)
    .find(([id]) => id === 'code_block')?.[1];
  if (!original) throw new Error('Crepe code block view is not registered');
  return (...args) => {
    const [node, view] = args;
    const block = original(...args);
    const update = block.update?.bind(block);
    if (!update) return block;
    let text = node.textContent;
    block.update = (next, ...decorations) => {
      // Crepe's readonly CodeMirror change filter rejects programmatic updates.
      if (!view.editable && next.textContent !== text) return false;
      const accepted = update(next, ...decorations);
      if (accepted) text = next.textContent;
      return accepted;
    };
    return block;
  };
});
