// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

interface MarkdownNode {
  type: string;
  value?: string;
  alt?: string | null;
  checked?: boolean | null;
  children?: MarkdownNode[];
  position?: { start: { line: number }; end: { line: number } };
}

const BLOCK_CONTAINERS = new Set(['root', 'blockquote', 'list', 'listItem']);

function plainText(node: MarkdownNode): string {
  if (node.type === 'html') {
    let text = node.value ?? '';
    let previous: string;
    // Removing a tag can join its surrounding text into another tag.
    do {
      previous = text;
      text = text.replace(/<\/?[a-z][^>]*>/gi, '');
    } while (text !== previous);
    return text;
  }
  if (node.type === 'definition' || node.type === 'thematicBreak') return '';
  if (node.type === 'break') return '\n';
  if (node.type === 'image' || node.type === 'imageReference')
    return node.alt ?? '';
  if (node.value !== undefined) return node.value;

  let text = '';
  let previous: MarkdownNode | undefined;
  for (const child of node.children ?? []) {
    const content = plainText(child);
    if (!content) continue;
    if (previous) {
      if (BLOCK_CONTAINERS.has(node.type)) {
        const lines =
          (child.position?.start.line ?? 0) -
          (previous.position?.end.line ?? 0);
        text += '\n'.repeat(Math.min(2, Math.max(1, lines)));
      } else if (node.type === 'table') text += '\n';
      else if (node.type === 'tableRow') text += '\t';
    }
    text += content;
    previous = child;
  }
  return node.type === 'listItem' && typeof node.checked === 'boolean'
    ? `[${node.checked ? 'x' : ' '}] ${text}`
    : text;
}

/**
 * Extract plain text for note conversion, excerpts, and thinking.
 * Parse code separately so identifiers, generics, and literal Markdown inside
 * code are not mistaken for formatting. Preserve source block spacing up to
 * one blank line; code content itself is left intact.
 * This is not an HTML sanitizer: literal code can contain HTML tags.
 */
export function stripMarkdown(input: string): string {
  if (!input) return '';
  return plainText(
    fromMarkdown(input, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }),
  ).trim();
}
