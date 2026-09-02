// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export { normalizeMathDelimiters } from '@huabu/shared/canvas-engine';

/**
 * Single source of truth for markdown string handling in the Milkdown layer.
 *
 * Every code path that emits or compares markdown produced by
 * `MilkdownEditor` MUST go through these helpers, so equality
 * semantics stay consistent across diffing, persistence, and
 * provenance tracking.
 */

/**
 * Normalize markdown for transport and equality checks:
 *  - Convert CRLF / CR to LF.
 *  - Strip trailing whitespace at the end of each line (Milkdown does not
 *    treat trailing spaces as semantically meaningful — the only case
 *    where it matters is the hard-break `<br>`, which we preserve below).
 *  - Trim trailing blank lines from the document end.
 *  - Preserve all leading whitespace (indentation) and the meaningful
 *    "two trailing spaces" hard-break marker.
 */
export function normalizeMarkdown(md: string): string {
  if (!md) return '';
  // 1. Unify line endings.
  let out = md.replace(/\r\n?/g, '\n');
  // 2. Trim all whitespace at the document end. This removes both
  //    trailing blank lines AND any trailing whitespace on the final
  //    line — a hard-break marker (`  `) at the very end has no
  //    semantic meaning because there is no following content.
  out = out.replace(/\s+$/, '');
  // 3. Per-line: strip trailing whitespace, but preserve the hard-break
  //    marker — a line ending in exactly two trailing spaces and
  //    followed by more content is a markdown hard line break.
  out = out
    .split('\n')
    .map((line) => {
      if (/\S {2,}$/.test(line)) {
        return line.replace(/ +$/, '  ');
      }
      return line.replace(/[ \t]+$/, '');
    })
    .join('\n');
  return out;
}

/**
 * Substitute an editor-safe placeholder for empty / whitespace-only input.
 *
 * Milkdown can render an empty document, but several Huabu code paths
 * (drag preview, AI prompt assembly) assume at least one paragraph exists.
 * Returning a single newline gives downstream code a stable "empty doc"
 * shape without inserting visible text.
 */
export function ensureNonEmpty(md: string): string {
  if (!md || !md.trim()) return '\n';
  return md;
}

/**
 * Returns true when two markdown strings are semantically equivalent
 * after `normalizeMarkdown`. Used to dedupe `onChange` callbacks so a
 * controlled `MilkdownEditor` does not loop on its own echo.
 */
export function markdownEquals(a: string, b: string): boolean {
  if (a === b) return true;
  return normalizeMarkdown(a) === normalizeMarkdown(b);
}
