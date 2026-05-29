/**
 * Pure text measurement utilities using pretext.
 *
 * Shared by TextNode and QuestionNode for auto-sizing and font-fill behaviour.
 * No DOM access — all arithmetic is done via canvas text-metrics.
 */

import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext';

/** Font options passed to measurement functions. */
export interface FontOpts {
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  lineHeight: number;
}

/**
 * Build the CSS font shorthand string for pretext's prepare().
 */
export function buildFontStr(
  fontSize: number,
  fontFamily: string,
  fontWeight: string,
  fontStyle: string,
): string {
  let s = '';
  if (fontStyle === 'italic') s += 'italic ';
  if (fontWeight === 'bold') s += 'bold ';
  return `${s}${fontSize}px ${fontFamily}`;
}

/**
 * Pretext treats `\n` as a line terminator (matching CSS layout): a
 * string that ends with `\n` produces the same number of laid-out lines
 * as the same string without the trailing newline. Inside an editable
 * textarea, however, the caret sits on a visually empty line right after
 * the trailing `\n`, so the container must reserve a line of height for
 * it — otherwise pressing Enter at the end of the text does not grow
 * the node until the user types the next character. Returns 1 when the
 * text ends with `\n`, else 0.
 */
function trailingEditableLines(text: string): number {
  return text.endsWith('\n') ? 1 : 0;
}

/**
 * Measure the natural content dimensions using pretext (no DOM reflow).
 * maxWidth controls the wrap boundary.
 */
export function measureTextContent(
  text: string,
  opts: FontOpts & { fontSize: number; maxWidth: number },
): { width: number; height: number } {
  const fontStr = buildFontStr(
    opts.fontSize,
    opts.fontFamily,
    opts.fontWeight,
    opts.fontStyle,
  );
  const prepared = prepareWithSegments(text || ' ', fontStr, {
    whiteSpace: 'pre-wrap',
  });
  const lineH = opts.fontSize * opts.lineHeight;
  const { height, lines } = layoutWithLines(prepared, opts.maxWidth, lineH);

  let maxW = 0;
  for (const line of lines) {
    if (line.width > maxW) maxW = line.width;
  }
  const extra = trailingEditableLines(text) * lineH;
  return { width: Math.ceil(maxW), height: Math.ceil(height + extra) };
}

/**
 * Binary-search for the font size that makes text fill a target height
 * at a given content width.  Uses pretext — pure arithmetic, no DOM access.
 */
export function computeFontSizeForHeight(
  text: string,
  contentWidth: number,
  contentHeight: number,
  opts: FontOpts,
): number {
  if (contentWidth <= 0 || contentHeight <= 0) return 16;
  if (!text.trim()) {
    return Math.max(
      1,
      Math.min(Math.round(contentHeight / opts.lineHeight), 200),
    );
  }

  // Reserve a small margin so browser rendering differences don't clip
  // the last line. 2px height absorbs sub-pixel rounding; 4px narrower
  // width forces pretext to wrap at least as aggressively as the browser
  // (especially for CJK + Latin mixed text where break opportunities differ).
  const safeHeight = contentHeight - 2;
  const safeWidth = contentWidth - 4;
  if (safeHeight <= 0 || safeWidth <= 0) return 1;

  let lo = 1;
  let hi = 200;
  const trailingLines = trailingEditableLines(text);
  for (let i = 0; i < 15; i++) {
    const mid = (lo + hi) / 2;
    const fontStr = buildFontStr(
      mid,
      opts.fontFamily,
      opts.fontWeight,
      opts.fontStyle,
    );
    const prepared = prepareWithSegments(text, fontStr, {
      whiteSpace: 'pre-wrap',
    });
    const lineH = mid * opts.lineHeight;
    const { height } = layoutWithLines(prepared, safeWidth, lineH);
    const totalHeight = height + trailingLines * lineH;
    if (totalHeight <= safeHeight) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.max(1, Math.floor(lo * 2) / 2);
}

/**
 * Measure the rendered height of `text` laid out at a fixed `fontSize`
 * inside a fixed `contentWidth`. Used by text-flow nodes to derive the
 * container height after the font size has been locked by a resize gesture.
 * Pure arithmetic via pretext — no DOM reflow.
 */
export function measureTextHeight(
  text: string,
  contentWidth: number,
  fontSize: number,
  opts: FontOpts,
): number {
  if (contentWidth <= 0 || fontSize <= 0) return 0;
  const fontStr = buildFontStr(
    fontSize,
    opts.fontFamily,
    opts.fontWeight,
    opts.fontStyle,
  );
  const prepared = prepareWithSegments(text || ' ', fontStr, {
    whiteSpace: 'pre-wrap',
  });
  const lineH = fontSize * opts.lineHeight;
  const { height } = layoutWithLines(prepared, contentWidth, lineH);
  const extra = trailingEditableLines(text) * lineH;
  return Math.ceil(height + extra);
}
