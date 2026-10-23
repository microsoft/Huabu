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
  position?: {
    start: { line: number; offset?: number };
    end: { line: number; offset?: number };
  };
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

/**
 * Resolve a literal source match into the parser's visible text projection.
 * Hidden syntax and transformations without an exact source mapping fail closed.
 */
export function markdownSearchTarget(
  source: string,
  offset: number,
  length: number,
): { text: string; start: number; end: number } | null {
  const tree: MarkdownNode = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  let text = '';
  let start: number | undefined;
  const visit = (node: MarkdownNode): void => {
    if (['definition', 'html', 'image', 'imageReference'].includes(node.type))
      return;
    if (node.value !== undefined) {
      const from = node.position?.start.offset;
      const to = node.position?.end.offset;
      if (from !== undefined && to !== undefined && node.value) {
        const raw = source.slice(from, to);
        let contentOffset = raw === node.value ? 0 : -1;
        if (node.type === 'inlineCode') {
          const delimiter = raw.match(/^`+/)?.[0].length ?? 0;
          if (raw.slice(delimiter, -delimiter) === node.value)
            contentOffset = delimiter;
        } else if (node.type === 'code' && /^(?:`{3,}|~{3,})/.test(raw)) {
          const bodyStart = raw.indexOf('\n') + 1;
          if (
            raw.slice(bodyStart, bodyStart + node.value.length) === node.value
          )
            contentOffset = bodyStart;
        }
        const relative = offset - from - contentOffset;
        if (
          contentOffset >= 0 &&
          relative >= 0 &&
          relative + length <= node.value.length
        )
          start = text.length + relative;
      }
      text += node.value;
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return start === undefined ? null : { text, start, end: start + length };
}
