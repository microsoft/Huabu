// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Pure pretext-based text measurement, used by TextNode/QuestionNode
 * auto-sizing (via {@link computeFontSizeForHeight}, a preset over the shared
 * {@link fitFontSize} core).
 *
 * Both paths use a single binary-search core that prepares the text
 * once at `REF_SIZE`, then reuses that measurement in every probe by
 * scaling the wrap budget — no `measureText` calls inside the loop.
 */

import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext';

/** Font options passed to measurement functions. */
export interface FontOpts {
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  lineHeight: number;
}

/** Reference size for the single per-call `prepare`; advances scale linearly. */
const REF_SIZE = 100;

/**
 * Strip `ui-*` CSS Fonts L4 generics from the family stack. Only used as a
 * fallback — see {@link resolveFamilyForCanvas}.
 */
function sanitizeFontFamilyForCanvas(family: string): string {
  return (
    family
      .split(',')
      .map((s) => s.trim())
      .filter((s) => !/^ui-(sans-serif|serif|monospace|rounded)$/i.test(s))
      .join(', ') || 'sans-serif'
  );
}

/** Font shorthand no engine can confuse with a real one, used as a probe. */
const FONT_PROBE_SENTINEL = '13.7px "__huabu_font_probe__"';

/** Size used for the probe — acceptance depends on the family, not the size. */
const FONT_PROBE_SIZE = 16;

let probeCtx: CanvasRenderingContext2D | null | undefined;

function getProbeCtx(): CanvasRenderingContext2D | null {
  if (probeCtx === undefined) {
    probeCtx =
      typeof document === 'undefined'
        ? null
        : document.createElement('canvas').getContext('2d');
  }
  return probeCtx;
}

/**
 * Memoised per family stack.
 *
 * Keying on the family and not the whole shorthand matters: `fontSize`
 * changes every frame of a resize drag, and this runs on the typing path.
 * One probe per distinct stack keeps the map at a handful of entries and
 * the hot path at a single map lookup.
 */
const resolvedFamilies = new Map<string, string>();

/**
 * Pick the family stack that measures what the DOM actually renders.
 *
 * The DOM keeps the authored stack, so measurement must use it too —
 * dropping a family the browser honours (`ui-sans-serif` on Safari)
 * measures a different typeface than the one on screen, and a width error
 * of a fraction of a percent turns into a whole reserved line whenever a
 * line sits near the wrap boundary.
 *
 * `ctx.font` is a silent setter: an unparsable value leaves the previous
 * one in place. Writing a sentinel first turns that silence into a
 * readable signal. Both outcomes land on the DOM's own font:
 * - accepted → canvas resolves the same stack as CSS;
 * - rejected → the engine cannot parse that family, so CSS skips it for
 *   the same reason and lands on the next entry, which is exactly what
 *   {@link sanitizeFontFamilyForCanvas} leaves behind.
 *
 * Without the probe, a stack containing `ui-*` would always take the
 * second branch — correct only on engines that do not support it.
 */
function resolveFamilyForCanvas(family: string): string {
  const cached = resolvedFamilies.get(family);
  if (cached !== undefined) return cached;

  const ctx = getProbeCtx();
  let resolved = sanitizeFontFamilyForCanvas(family);

  if (ctx) {
    ctx.font = FONT_PROBE_SENTINEL;
    const sentinel = ctx.font;
    ctx.font = `${FONT_PROBE_SIZE}px ${family}`;
    if (ctx.font !== sentinel) resolved = family;
  }

  resolvedFamilies.set(family, resolved);
  return resolved;
}

/** Build the CSS font shorthand string for pretext's prepare(). */
export function buildFontStr(
  fontSize: number,
  fontFamily: string,
  fontWeight: string,
  fontStyle: string,
): string {
  let s = '';
  if (fontStyle === 'italic') s += 'italic ';
  if (fontWeight === 'bold') s += 'bold ';
  return `${s}${fontSize}px ${resolveFamilyForCanvas(fontFamily)}`;
}

/**
 * Maximal runs of non-CJK, non-whitespace chars (Latin words, URLs, …).
 * CJK is excluded because it breaks per-character; ZWS/soft hyphen are
 * treated as separators to mirror pretext's break opportunities.
 */
function extractUnbreakableTokens(text: string): string[] {
  const wordCharRe =
    /[^\s\u00AD\u200B\u3000-\u303F\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
  const tokens: string[] = [];
  let current = '';
  for (const ch of text) {
    if (wordCharRe.test(ch)) {
      current += ch;
    } else if (current) {
      tokens.push(current);
      current = '';
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * 1 if `text` ends with `\n`: pretext drops the trailing empty line
 * (matches CSS), but a textarea still shows a caret line there, so the
 * editor path reserves one extra line of height.
 */
function trailingEditableLines(text: string): number {
  return text.endsWith('\n') ? 1 : 0;
}

/**
 * Measure the natural content dimensions using pretext (no DOM reflow).
 * `maxWidth` controls the wrap boundary.
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
 * Height of `text` laid out at a fixed `fontSize` inside `contentWidth`.
 * Used after a resize gesture locks the font, to derive the container height.
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

/* ---------------- Unified font-fit core ---------------- */

/** Options accepted by {@link fitFontSize}. */
interface FitFontOptions {
  /** Default 1. */
  minSize?: number;
  /** Default 200. */
  maxSize?: number;
  /**
   * Allow descending below `minSize` down to this floor when even
   * `minSize` can't keep the widest unbreakable token on one line.
   * Default = `minSize` (no descent; word breaks).
   */
  floorSize?: number;
  /** Snap result down to a multiple of this many px (default 0.5). */
  snapStep?: number;
  /** Default 12. */
  iterations?: number;
  /** Reserve one line of height when text ends with `\n` (default false). */
  reserveTrailingLine?: boolean;
  /** Default 0. */
  widthInset?: number;
  /** Default 0. */
  heightInset?: number;
  /** Optional global cache (used by the placeholder path on zoom-out bursts). */
  cache?: Map<string, number>;
  /** Default 4096; cleared when exceeded. */
  cacheMax?: number;
  /** If true, empty text returns size = contentHeight / lineHeight. */
  emptyTextFillsHeight?: boolean;
}

/**
 * Binary-search the largest font size whose laid-out text fits inside
 * `contentWidth × contentHeight`. Guarantees the widest unbreakable
 * token stays on one line (pretext otherwise applies `overflow-wrap:
 * break-word`). Single `prepare` at `REF_SIZE`; each probe wraps the
 * prepared run at the scaled budget `realBudget * REF_SIZE / mid` —
 * no `measureText` calls inside the loop.
 */
function fitFontSize(
  text: string,
  contentWidth: number,
  contentHeight: number,
  font: FontOpts,
  opts: FitFontOptions = {},
): number {
  const minSize = opts.minSize ?? 1;
  const maxSize = opts.maxSize ?? 200;
  const floorSize = Math.min(opts.floorSize ?? minSize, minSize);
  const snapStep = opts.snapStep ?? 0.5;
  const iterations = opts.iterations ?? 12;
  const reserveTrailingLine = opts.reserveTrailingLine ?? false;
  const widthInset = opts.widthInset ?? 0;
  const heightInset = opts.heightInset ?? 0;
  const cache = opts.cache;
  const cacheMax = opts.cacheMax ?? 4096;
  const emptyTextFillsHeight = opts.emptyTextFillsHeight ?? false;

  const safeWidth = contentWidth - widthInset;
  const safeHeight = contentHeight - heightInset;
  if (safeWidth <= 0 || safeHeight <= 0) return Math.max(floorSize, 1);

  if (!text.trim()) {
    if (emptyTextFillsHeight) {
      return Math.max(
        floorSize,
        Math.min(Math.round(contentHeight / font.lineHeight), maxSize),
      );
    }
    return Math.max(floorSize, minSize);
  }

  const cacheKey = cache
    ? `${minSize}|${maxSize}|${floorSize}|${snapStep}|${reserveTrailingLine}|${widthInset}|${heightInset}|${font.fontFamily}|${font.fontWeight}|${font.fontStyle}|${font.lineHeight}|${safeWidth}|${safeHeight}|${text}`
    : null;
  if (cacheKey && cache) {
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
  }

  const refFontStr = buildFontStr(
    REF_SIZE,
    font.fontFamily,
    font.fontWeight,
    font.fontStyle,
  );
  const prepared = prepareWithSegments(text, refFontStr, {
    whiteSpace: 'pre-wrap',
  });

  // widestTokenAtRef = the exact value pretext compares against
  // `maxWidth` when deciding whether to break a word, so the guard
  // `widestTokenAtRef <= scaledWidth` fires iff pretext would break.
  let widestTokenAtRef = 0;
  for (const tok of extractUnbreakableTokens(text)) {
    const tokPrepared = prepareWithSegments(tok, refFontStr, {
      whiteSpace: 'pre-wrap',
    });
    const { lines: tokLines } = layoutWithLines(
      tokPrepared,
      Number.POSITIVE_INFINITY,
      1,
    );
    for (const ln of tokLines) {
      if (ln.width > widestTokenAtRef) widestTokenAtRef = ln.width;
    }
  }

  const trailingLines = reserveTrailingLine ? trailingEditableLines(text) : 0;
  // lineH in REF units is constant (real lineH = mid*ratio → REF units = REF*ratio).
  const lineHRef = REF_SIZE * font.lineHeight;

  const fitsAt = (size: number): boolean => {
    const scaledWidth = (safeWidth * REF_SIZE) / size;
    const scaledHeight = (safeHeight * REF_SIZE) / size;
    const { height } = layoutWithLines(prepared, scaledWidth, lineHRef);
    const totalHeight = height + trailingLines * lineHRef;
    return totalHeight <= scaledHeight && widestTokenAtRef <= scaledWidth;
  };

  // Phase 1: search [minSize, maxSize]. Phase 2 (only if min doesn't
  // even fit and `floorSize < minSize`): descend [floorSize, minSize]
  // so a single oversized word can shrink below min instead of breaking.
  let lo: number;
  let hi: number;
  if (fitsAt(minSize)) {
    lo = minSize;
    hi = maxSize;
  } else if (floorSize < minSize) {
    lo = floorSize;
    hi = minSize;
  } else {
    lo = hi = floorSize;
  }
  for (let i = 0; i < iterations && lo < hi; i++) {
    const mid = (lo + hi) / 2;
    if (fitsAt(mid)) lo = mid;
    else hi = mid;
  }

  const snapped = Math.max(floorSize, Math.floor(lo / snapStep) * snapStep);
  if (cacheKey && cache) {
    if (cache.size >= cacheMax) cache.clear();
    cache.set(cacheKey, snapped);
  }
  return snapped;
}

/**
 * Largest font size that fills `contentHeight` at `contentWidth` for
 * TextNode / QuestionNode / frame-resize cascade. Snaps to whole px so
 * the persisted `data.style.fontSize` matches the integer shown in the
 * toolbar, reserves a trailing caret line, small safety inset, no cache.
 */
export function computeFontSizeForHeight(
  text: string,
  contentWidth: number,
  contentHeight: number,
  opts: FontOpts,
): number {
  if (contentWidth <= 0 || contentHeight <= 0) return 16;
  return fitFontSize(text, contentWidth, contentHeight, opts, {
    minSize: 1,
    maxSize: 200,
    floorSize: 1,
    snapStep: 1,
    iterations: 15,
    reserveTrailingLine: true,
    widthInset: 4,
    heightInset: 2,
    emptyTextFillsHeight: true,
  });
}
