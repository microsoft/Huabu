// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface MarkdownFrontmatterSplit {
  /**
   * Normalized YAML text inside a leading `---` ... `---` block, or `null`
   * when the document has no closed leading frontmatter block.
   */
  frontmatter: string | null;
  /** Markdown content to render as the document body. */
  body: string;
}

const OPENING_FENCE_RE = /^---[ \t]*(?:\r\n|\n|\r)/;
const CLOSING_FENCE_RE = /^---[ \t]*$/;

/**
 * Splits an optional leading YAML frontmatter block (`---` ... `---`) from a
 * complete Markdown document without parsing or executing arbitrary metadata.
 *
 * Only a fence starting at the very beginning of the file (allowing an
 * optional UTF-8 BOM) and closed by a column-0 `---` fence is recognized.
 * Unterminated opening fences, ordinary horizontal rules later in the file,
 * four-or-more dash rules, and fenced YAML code blocks leave `frontmatter`
 * as `null` and preserve `text` verbatim as `body`.
 */
export function splitMarkdownFrontmatter(
  text: string,
): MarkdownFrontmatterSplit {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const openMatch = OPENING_FENCE_RE.exec(withoutBom);
  if (!openMatch) {
    return { frontmatter: null, body: text };
  }

  let pos = openMatch[0].length;
  while (pos < withoutBom.length) {
    let lineEnd = pos;
    while (
      lineEnd < withoutBom.length &&
      withoutBom[lineEnd] !== '\n' &&
      withoutBom[lineEnd] !== '\r'
    ) {
      lineEnd += 1;
    }

    const nextPos =
      lineEnd < withoutBom.length
        ? withoutBom[lineEnd] === '\r' && withoutBom[lineEnd + 1] === '\n'
          ? lineEnd + 2
          : lineEnd + 1
        : lineEnd;

    const line = withoutBom.slice(pos, lineEnd);
    if (CLOSING_FENCE_RE.test(line)) {
      const rawFrontmatter = withoutBom.slice(openMatch[0].length, pos);
      const frontmatter = rawFrontmatter
        .replace(/\r\n?/g, '\n')
        .replace(/\n$/, '');
      return {
        frontmatter,
        body: withoutBom.slice(nextPos),
      };
    }

    if (lineEnd === withoutBom.length) break;
    pos = nextPos;
  }

  return { frontmatter: null, body: text };
}
