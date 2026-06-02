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
 * Milkdown can render an empty document, but several Sediment code paths
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

/**
 * Convert LaTeX-style math delimiters (`\[…\]`, `\(…\)`) used by many
 * AI assistants into the canonical Markdown math delimiters that
 * `remark-math` (Crepe's `latex` feature) understands: `$$…$$` for
 * display math and `$…$` for inline math.
 *
 * Why this lives at the Milkdown entry point:
 *   - `remark-math` only supports `$…$` / `$$…$$`. There is no
 *     upstream option to accept `\[…\]` / `\(…\)`.
 *   - LLMs frequently emit the LaTeX forms, so we normalize on the
 *     way IN to the editor.
 *
 * SCOPE — per product decision this helper targets AI-generated
 * content only. The CommonMark escape sequence `\[` (literal `[`)
 * will be incorrectly converted by this function; we accept that
 * trade-off because users are not expected to type LaTeX-style
 * bracket escapes in this app.
 *
 * Safeguards still in place:
 *   - Fenced code blocks (` ``` ` / `~~~`) are skipped entirely so
 *     LaTeX SOURCE pasted into a code block remains literal.
 *   - Inline code spans (`` ` ``) are skipped for the same reason.
 *   - Unpaired `\[` or `\(` (e.g. a partial AI stream chunk) is
 *     left alone — only matched pairs are rewritten. The closing
 *     delimiter arriving in a later chunk completes the rewrite.
 *
 * Output shape:
 *   - `\[…\]` is emitted as a block-form math paragraph
 *     (`\n\n$$\n<inner>\n$$\n\n`) so that `remark-math` parses it as
 *     display math (it requires the opening / closing `$$` to sit on
 *     their own lines).
 *   - `\(…\)` is emitted as inline math `$<inner>$` and is not
 *     allowed to span newlines.
 *   - The transformation is idempotent: running it on the converted
 *     output is a no-op.
 */
export function normalizeMathDelimiters(md: string): string {
  if (!md) return md;
  const segments = splitFencedCode(md);
  const converted = segments
    .map((seg) => (seg.isCode ? seg.text : convertOutsideCode(seg.text)))
    .join('\n');
  // Collapse runs of 3+ newlines that may appear when we surround a
  // block math span with `\n\n…\n\n` while it already had blank lines
  // adjacent in the input.
  return converted.replace(/\n{3,}/g, '\n\n');
}

interface MarkdownSegment {
  text: string;
  isCode: boolean;
}

/**
 * Cheap CommonMark fenced-code splitter. Splits the input into a
 * sequence of segments, each marked as either fenced code (left
 * verbatim) or outside-code (eligible for math delimiter rewriting).
 *
 * Not a full CommonMark parser — it intentionally only recognises
 * fences that:
 *   - start with up to three spaces of indent,
 *   - are made of three or more ` ` ` or `~` characters,
 *   - close with the same character at the same or greater length on
 *     a line that contains nothing but fence characters.
 *
 * Joining the segments back with a single `\n` reproduces the original
 * input exactly.
 */
function splitFencedCode(md: string): MarkdownSegment[] {
  const lines = md.split('\n');
  const out: MarkdownSegment[] = [];
  let codeStart = -1;
  let outsideStart = 0;
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match && fenceChar === null) {
      if (outsideStart < i) {
        out.push({
          text: lines.slice(outsideStart, i).join('\n'),
          isCode: false,
        });
      } else if (outsideStart === i && i > 0) {
        // Two adjacent fences with no outside content between them —
        // emit an empty outside segment to preserve the `\n` between
        // the closing and opening fences when we rejoin.
        out.push({ text: '', isCode: false });
      }
      codeStart = i;
      fenceChar = match[1][0];
      fenceLen = match[1].length;
      continue;
    }
    if (match && fenceChar !== null) {
      const ch = match[1][0];
      const len = match[1].length;
      if (ch === fenceChar && len >= fenceLen && line.trim().length === len) {
        out.push({
          text: lines.slice(codeStart, i + 1).join('\n'),
          isCode: true,
        });
        outsideStart = i + 1;
        codeStart = -1;
        fenceChar = null;
        fenceLen = 0;
      }
    }
  }

  if (fenceChar !== null) {
    // Unclosed fence — treat the trailing region as code so the
    // (likely in-progress) source isn't accidentally rewritten.
    out.push({ text: lines.slice(codeStart).join('\n'), isCode: true });
  } else if (outsideStart < lines.length) {
    out.push({ text: lines.slice(outsideStart).join('\n'), isCode: false });
  } else if (outsideStart === lines.length && out.length > 0) {
    // The doc ended exactly at a closing fence; nothing to emit.
  }

  return out;
}

/**
 * Walk the segment splitting out inline code spans (`` `…` ``,
 * `` ``…`` ``, etc.) so we never rewrite math-like content that the
 * author put inside backticks.
 */
function convertOutsideCode(text: string): string {
  if (!text) return text;
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const tickStart = text.indexOf('`', i);
    if (tickStart === -1) {
      out.push(convertMathInPlain(text.slice(i)));
      break;
    }
    if (tickStart > i) {
      out.push(convertMathInPlain(text.slice(i, tickStart)));
    }
    const tickRunMatch = /^`+/.exec(text.slice(tickStart));
    // `tickRunMatch` cannot be null — we just confirmed there is a backtick
    // at `tickStart` — but TypeScript needs the guard.
    if (!tickRunMatch) {
      out.push(convertMathInPlain(text.slice(tickStart)));
      break;
    }
    const tickRun = tickRunMatch[0];
    const restStart = tickStart + tickRun.length;
    const closeRel = text.slice(restStart).indexOf(tickRun);
    if (closeRel === -1) {
      // Unmatched backtick run — treat the tail as plain text.
      out.push(convertMathInPlain(text.slice(tickStart)));
      break;
    }
    const codeEnd = restStart + closeRel + tickRun.length;
    out.push(text.slice(tickStart, codeEnd));
    i = codeEnd;
  }
  return out.join('');
}

function convertMathInPlain(text: string): string {
  // Block math: \[ … \]. The inner is matched lazily and is not
  // allowed to contain a `\]` (so multiple block formulas on the
  // same line don't fuse into one).
  let out = text.replace(
    /\\\[((?:(?!\\\])[\s\S])*)\\\]/g,
    (_match, inner: string) => {
      const trimmed = inner.trim();
      return `\n\n$$\n${trimmed}\n$$\n\n`;
    },
  );
  // Inline math: \( … \). Disallow newlines inside the content so a
  // stray `\(` doesn't swallow paragraphs of text.
  out = out.replace(
    /\\\(((?:(?!\\\))[^\n])*)\\\)/g,
    (_match, inner: string) => `$${inner}$`,
  );
  return out;
}
