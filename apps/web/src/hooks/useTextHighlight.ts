// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
 * 17.2+, Firefox 140+). Huabu ships inside Electron 30+, which
 * embeds Chromium ≥ 124, so support is guaranteed there.
 *
 * For environments that somehow lack the API (jsdom in tests), the
 * hook is a no-op — the search overlay still works, just without the
 * inline highlight layer.
 */

import { useEffect, useState } from 'react';

import { findRanges } from './searchDom';

/** Global registered highlight name. CSS selector: `::highlight(huabu-search)`. */
const HIGHLIGHT_NAME = 'huabu-search';

interface UseTextHighlightOptions {
  /**
   * Container(s) whose descendant text nodes get scanned. Pass an
   * array to merge ranges from multiple subtrees into a single
   * `::highlight()` registration — used when the canvas-wide search
   * needs to paint matches on both the canvas root and the expanded
   * preview panel at the same time. `null` (or an array of only
   * `null`s) clears the highlight set.
   */
  container: HTMLElement | (HTMLElement | null)[] | null;
  /** Needle. Empty string clears the highlight set. */
  query: string;
  /** Soft cap on Range objects we'll register (across all containers). */
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

  // Normalise to an array of live elements so the dependency array
  // below stays stable when the caller switches between single and
  // multi-container forms. `useMemo` would re-allocate on every
  // render anyway since the array literal is fresh; we instead
  // compare element identity inside the effect by feeding a serialised
  // key through the deps.
  const containerList: (HTMLElement | null)[] = Array.isArray(container)
    ? container
    : [container];
  // Deps key built from element identity. React only re-runs the
  // effect when an underlying element swaps in/out — adding or
  // removing a `null` from the array does not retrigger.
  const liveContainers = containerList.filter(
    (c): c is HTMLElement => c !== null,
  );
  // Stringify identities via a WeakRef-free trick: tag each element
  // with a sequential id so the dep value is a primitive string.
  // Cheaper than a `useMemo` + array-equality check, and avoids the
  // pitfall of `[a, b]` deps being a fresh array each render.
  const depKey = liveContainers.map(elementId).join('|');

  useEffect(() => {
    const HighlightCtor: typeof Highlight | undefined = (
      globalThis as unknown as { Highlight?: typeof Highlight }
    ).Highlight;
    const highlights = (
      CSS as unknown as { highlights?: Map<string, Highlight> }
    ).highlights;

    // No-container / no-query / no-API → make sure count is zeroed
    // even when the API isn't available (jsdom in tests).
    if (liveContainers.length === 0 || !query) {
      highlights?.delete(HIGHLIGHT_NAME);
      setMatchCount(0);
      return;
    }
    if (!HighlightCtor || !highlights) {
      // API unavailable — still surface a count so the find bar can
      // advance, since the fallback `findNthRange` walk uses the same
      // DOM independently of the registered highlight.
      let initial = 0;
      for (const c of liveContainers) {
        initial += findRanges(c, query, maxRanges - initial).length;
        if (initial >= maxRanges) break;
      }
      setMatchCount(initial);
      return;
    }

    const apply = (): void => {
      const ranges: Range[] = [];
      for (const c of liveContainers) {
        const remaining = maxRanges - ranges.length;
        if (remaining <= 0) break;
        // `findRanges` checks `document.contains` implicitly via
        // `createTreeWalker`; a container that detached between
        // renders just yields zero ranges.
        ranges.push(...findRanges(c, query, remaining));
      }
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

    const observers = liveContainers.map((c) => {
      const o = new MutationObserver(schedule);
      o.observe(c, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          'aria-hidden',
          'class',
          'data-preview-search-content',
          'data-search-exclude',
          'hidden',
          'style',
        ],
      });
      return o;
    });

    return () => {
      if (scheduled) cancelAnimationFrame(scheduled);
      for (const o of observers) o.disconnect();
      highlights.delete(HIGHLIGHT_NAME);
    };
    // `liveContainers` is rebuilt every render but `depKey` collapses
    // it into a primitive identity string, so the effect only re-runs
    // when an actual element comes/goes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey, query, maxRanges]);

  return { matchCount };
}

/** Monotonic id-per-element used to build a stable effect dep key. */
const elementIds = new WeakMap<HTMLElement, number>();
let nextElementId = 1;
function elementId(el: HTMLElement): string {
  let id = elementIds.get(el);
  if (id === undefined) {
    id = nextElementId++;
    elementIds.set(el, id);
  }
  return String(id);
}
