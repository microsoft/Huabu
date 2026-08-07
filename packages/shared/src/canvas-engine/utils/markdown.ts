// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Convert a Markdown string to plain text by stripping common syntax.
 *
 * Used when a `note` node is converted to a `text` node — the latter has no
 * Markdown renderer, so leftover `**bold**` / `# heading` / `[link](url)` etc
 * would show up as literal characters. The transform is intentionally
 * heuristic (no full Markdown parser) because:
 *   1. The conversion is recoverable via undo.
 *   2. We only need a "good-enough" plain-text projection for short snippets.
 *
 * Handled syntax:
 *   - ATX / setext headings
 *   - Bold / italic / strikethrough emphasis
 *   - Inline code and fenced code blocks
 *   - Links `[text](url)` → `text`; images `![alt](url)` → `alt`
 *   - Blockquotes (`>` prefix)
 *   - Unordered (`-`, `*`, `+`) and ordered (`1.`) list markers
 *   - Horizontal rules
 *   - HTML tags (stripped)
 *
 * Not handled (rare in casual paste flows):
 *   - Tables, footnotes, reference-style links, task lists
 */
export function stripMarkdown(input: string): string {
  if (!input) return '';

  let text = input;

  // Fenced code blocks ```lang\n...\n``` → keep inner content
  text = text.replace(/```[^\n]*\n([\s\S]*?)\n```/g, '$1');
  // Indented code blocks are left as-is (they are still readable plain text).

  // Images ![alt](url) → alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Strip raw HTML tags
  text = text.replace(/<\/?[a-z][^>]*>/gi, '');

  // Headings: leading `#` (ATX) and trailing `#`
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/\s+#+\s*$/gm, '');
  // Setext underline (=== / ---) → drop the underline line
  text = text.replace(/^\s{0,3}[=-]{2,}\s*$/gm, '');

  // Blockquote prefix
  text = text.replace(/^\s{0,3}>\s?/gm, '');

  // Horizontal rules: a line containing only 3+ of `-`, `*`, or `_`
  // (optionally separated by spaces). Anchored to end-of-line so the regex
  // never spans into the following paragraph.
  text = text.replace(/^\s{0,3}(?:-[ \t]*){3,}\s*$/gm, '');
  text = text.replace(/^\s{0,3}(?:\*[ \t]*){3,}\s*$/gm, '');
  text = text.replace(/^\s{0,3}(?:_[ \t]*){3,}\s*$/gm, '');

  // List markers: `- `, `* `, `+ `, `1. `
  text = text.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '');

  // Emphasis — order matters: bold/strike before italic.
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1'); // **bold**
  text = text.replace(/__([^_]+)__/g, '$1'); // __bold__
  text = text.replace(/~~([^~]+)~~/g, '$1'); // ~~strike~~
  text = text.replace(/(^|[^*])\*([^*\n]*[^*\n\\])\*/g, '$1$2'); // *italic*
  text = text.replace(/(^|[^_])_([^_\n]*[^_\n\\])_(?!_)/g, '$1$2'); // _italic_

  // Inline code `code`
  text = text.replace(/`([^`]+)`/g, '$1');

  // Collapse 3+ blank lines to 2, then trim outer whitespace.
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}
