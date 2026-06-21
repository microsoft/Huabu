/**
 * Paint highlights over text nodes inside a container without mutating
 * the DOM, using the CSS Custom Highlight API.
 *
 * Why not `<mark>`-wrapping or `.innerHTML` rewriting:
 *   - The preview content lives in Milkdown / pdf.js / sandboxed iframes
 *     that own their own DOM and react badly to mutations.
 *   - `<mark>` injection breaks text selection ranges, screen readers,
 *     and any incremental rendering downstream.
 *
 * The Highlight API attaches a `Highlight` object (a set of `Range`s)
 * to a registered name (`CSS.highlights.set(name, hl)`) and the
 * browser paints them via `::highlight(name)` in CSS. Text nodes,
 * selection, and accessibility are completely untouched.
 *
 * Supported in all evergreen browsers since 2023 (Chrome 105+, Safari
 * 17.2+, Firefox 140+). Sediment ships inside Electron 30+, which
 * embeds Chromium ≥ 124, so support is guaranteed there.
 *
 * For environments that somehow lack the API (jsdom in tests), the
 * hook is a no-op — the search overlay still works, just without the
 * inline highlight layer.
 */

import { useEffect, useState } from 'react';

/** Global registered highlight name. CSS selector: `::highlight(sediment-search)`. */
const HIGHLIGHT_NAME = 'sediment-search';

interface UseTextHighlightOptions {
  /** Container whose descendant text nodes get scanned. */
  container: HTMLElement | null;
  /** Needle. Empty string clears the highlight set. */
  query: string;
  /** Soft cap on Range objects we'll register. */
  maxRanges?: number;
}

export interface UseTextHighlightResult {
  /**
   * Current number of registered match ranges. Updates whenever the
   * MutationObserver re-walks the container, so consumers showing a
   * `1/N` counter stay in sync with text that mounts asynchronously
   * (pdf.js text layer, Milkdown lazy editor, virtualised lists).
   *
   * Capped by `maxRanges` — when the underlying document has more
   * matches than the cap, this number reflects what was registered,
   * not the true total.
   */
  matchCount: number;
}

/**
 * Scan `container`'s text nodes for case-insensitive `query` matches
 * and register a `Highlight` covering all of them. Reapplies whenever
 * `container` or `query` changes; cleans up on unmount.
 *
 * A `MutationObserver` re-walks the container when its subtree
 * changes — required for surfaces that fill in their text layer
 * asynchronously after the initial mount:
 *   - pdf.js renders the text layer (real `<span>`s) per-page once
 *     the canvas finishes rasterising — without the observer the
 *     highlight would attach to an empty subtree and stay dark.
 *   - Canvas note nodes mount Milkdown lazily on first paint.
 *   - Virtualised result lists insert / remove rows on scroll.
 * Mutation callbacks are coalesced through `requestAnimationFrame`
 * so a burst of insertions only triggers one re-walk per frame.
 *
 * Returns the live `matchCount`, kept in sync with the registered
 * range set across the same MutationObserver cycle so consumers
 * (e.g. an "n/m" counter in the find bar) don't have to maintain
 * their own walk.
 */
export function useTextHighlight({
  container,
  query,
  maxRanges = 500,
}: UseTextHighlightOptions): UseTextHighlightResult {
  const [matchCount, setMatchCount] = useState(0);

  useEffect(() => {
    const HighlightCtor: typeof Highlight | undefined = (
      globalThis as unknown as { Highlight?: typeof Highlight }
    ).Highlight;
    const highlights = (
      CSS as unknown as { highlights?: Map<string, Highlight> }
    ).highlights;

    // No-container / no-query / no-API → make sure count is zeroed
    // even when the API isn't available (jsdom in tests).
    if (!container || !query) {
      highlights?.delete(HIGHLIGHT_NAME);
      setMatchCount(0);
      return;
    }
    if (!HighlightCtor || !highlights) {
      // API unavailable — still surface a count so the find bar can
      // advance, since the fallback `findNthRange` walk uses the same
      // DOM independently of the registered highlight.
      const initial = findRanges(container, query, maxRanges).length;
      setMatchCount(initial);
      return;
    }

    const apply = (): void => {
      const ranges = findRanges(container, query, maxRanges);
      // Only update state when the count actually changes — avoids
      // a render storm during pdf.js's per-page text-layer mounts.
      setMatchCount((prev) => (prev === ranges.length ? prev : ranges.length));
      if (ranges.length === 0) {
        highlights.delete(HIGHLIGHT_NAME);
        return;
      }
      // Highlight constructor accepts an iterable of Range.
      highlights.set(
        HIGHLIGHT_NAME,
        new HighlightCtor(
          ...(ranges as unknown as ConstructorParameters<typeof Highlight>),
        ),
      );
    };

    apply();

    let scheduled = 0;
    const schedule = (): void => {
      if (scheduled) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = 0;
        apply();
      });
    };

    const observer = new MutationObserver(schedule);
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      if (scheduled) cancelAnimationFrame(scheduled);
      observer.disconnect();
      highlights.delete(HIGHLIGHT_NAME);
    };
  }, [container, query, maxRanges]);

  return { matchCount };
}

function findRanges(
  root: HTMLElement,
  query: string,
  maxRanges: number,
): Range[] {
  const needle = query.toLowerCase();
  const needleLen = needle.length;
  if (needleLen === 0) return [];

  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // Skip script/style nodes by checking the parent tag.
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current && ranges.length < maxRanges) {
    const text = current.textContent ?? '';
    if (text.length >= needleLen) {
      const lower = text.toLowerCase();
      let from = 0;
      while (ranges.length < maxRanges) {
        const idx = lower.indexOf(needle, from);
        if (idx === -1) break;
        const range = document.createRange();
        range.setStart(current, idx);
        range.setEnd(current, idx + needleLen);
        ranges.push(range);
        from = idx + Math.max(1, needleLen);
      }
    }
    current = walker.nextNode();
  }
  return ranges;
}
