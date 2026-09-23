// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { stripMarkdown } from '@huabu/shared/canvas-engine';

function plainText(markdown: string): string {
  return stripMarkdown(markdown).replace(/\s+/g, ' ').trim();
}

function comparisonKey(text: string): string {
  return plainText(text)
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

/** A lightweight prose excerpt from available Markdown, without an editor or parser. */
export function noteFarDescription(
  markdown: string,
  title: string,
): string | undefined {
  // Strip entire fenced blocks, including blank lines and unclosed fences.
  // The shared stripper deliberately retains code, which is not prose here.
  let fence: string | undefined;
  const prose = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        ) {
          fence = undefined;
        }
        return '';
      }
      if (marker) {
        fence = marker[1];
        return '';
      }
      return line;
    })
    .join('\n');

  const titleKey = comparisonKey(title);
  for (const paragraph of withoutImageText(prose).split(/\n[ \t]*\n/)) {
    // Lists (including their continuation lines) and indented code are not
    // prose paragraphs. Keep this heuristic local rather than parsing a document.
    if (/^(?: {0,3}(?:[-*+]|\d+[.)])[ \t]+| {4}|\t)/.test(paragraph)) continue;
    const lines = paragraph.split('\n');
    const body = lines
      .filter(
        (line, index) =>
          !/^ {0,3}#{1,6}(?:\s|$)/.test(line) &&
          !/^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[index + 1] ?? '') &&
          !/^ {0,3}(?:=+|-+)[ \t]*$/.test(line),
      )
      .join('\n');
    const text = plainText(body);
    if (/[\p{L}\p{N}]/u.test(text) && comparisonKey(text) !== titleKey) {
      return text;
    }
  }
  return undefined;
}
