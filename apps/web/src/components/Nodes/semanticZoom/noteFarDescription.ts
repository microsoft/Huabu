// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  markdownExcerptParagraphs,
  stripMarkdown,
} from '@huabu/shared/canvas-engine';

function comparisonKey(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?。！？:：]+$/u, '')
    .toLowerCase();
}

/** Exclude media labels before the shared stripper turns image alt into prose. */
function withoutImageText(markdown: string): string {
  return (
    markdown
      // Inline, reference, and shortcut images; preserve adjacent real prose.
      .replace(
        /!\[(?:\\.|[^\]\\])*\](?:\((?:\\.|[^()\\]|\([^()]*\))*\)|[ \t]*\[[^\]]*\])?/g,
        '',
      )
      .replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption\s*>/gi, '')
      .replace(/<img\b[^>]*>/gi, '')
      // Reference destinations are metadata, not a candidate paragraph.
      .replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*(?:\n[ \t]+[^\n]*)*/gm, '')
  );
}

/** A plain-text excerpt of prose and lists, using the shared Markdown parser. */
export function noteFarDescription(
  markdown: string,
  title: string,
): string | undefined {
  const titleKey = comparisonKey(stripMarkdown(title));
  const paragraphs: string[] = [];
  for (const text of markdownExcerptParagraphs(withoutImageText(markdown))) {
    if (/[\p{L}\p{N}]/u.test(text) && comparisonKey(text) !== titleKey) {
      paragraphs.push(text);
    }
  }
  return paragraphs.length ? paragraphs.join(' ') : undefined;
}
