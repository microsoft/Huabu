// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared DOM-walk helpers for the search subsystem.
 *
 * Independent of the registered `::highlight()` set so callers can
 * seek the n-th occurrence of a query string in a subtree and scroll
 * it into view without touching the visual highlight layer.
 *
 * Used by:
 *   - `InPreviewSearchBar` for Next / Prev navigation inside the
 *     expanded preview.
 *   - `CanvasSearchResults` for conversation-thread result navigation.
 */

/**
 * Find the `nth` (0-based) case-insensitive occurrence of `query`
 * inside `root`'s text nodes and return it as a `Range`, or `null`
 * if there aren't that many matches.
 *
 * Walks in document order. When the preview declares one or more
 * `[data-preview-search-content]` roots, only those document surfaces are
 * searched; otherwise the whole root is used as a compatibility fallback.
 * Hidden content and explicitly excluded chrome are always skipped.
 */
export function findNthRange(
  root: HTMLElement,
  query: string,
  nth: number,
): Range | null {
  const needle = query.toLowerCase();
  if (!needle) return null;
  const ranges = findRanges(root, query, nth + 1);
  return ranges[nth] ?? null;
}

/**
 * Find case-insensitive occurrences of `query` in user-facing preview text.
 * Exported so counting, highlighting, and match navigation share exactly the
 * same search boundary and visibility rules.
 */
export function findRanges(
  root: HTMLElement,
  query: string,
  maxRanges = Number.POSITIVE_INFINITY,
): Range[] {
  const needle = query.toLowerCase();
  if (!needle || maxRanges <= 0) return [];

  const ranges: Range[] = [];
  for (const searchRoot of getSearchRoots(root)) {
    const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        isSearchableTextNode(node, searchRoot)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    let current = walker.nextNode();
    while (current && ranges.length < maxRanges) {
      const text = (current.textContent ?? '').toLowerCase();
      let from = 0;
      while (ranges.length < maxRanges) {
        const idx = text.indexOf(needle, from);
        if (idx === -1) break;
        const range = document.createRange();
        range.setStart(current, idx);
        range.setEnd(current, idx + needle.length);
        ranges.push(range);
        from = idx + Math.max(1, needle.length);
      }
      current = walker.nextNode();
    }
    if (ranges.length >= maxRanges) break;
  }
  return ranges;
}

function getSearchRoots(root: HTMLElement): HTMLElement[] {
  if (root.matches('[data-preview-search-content]')) return [root];
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>('[data-preview-search-content]'),
  );
  const topLevelCandidates = candidates.filter(
    (candidate) =>
      !candidate.parentElement?.closest('[data-preview-search-content]'),
  );
  return topLevelCandidates.length > 0 ? topLevelCandidates : [root];
}

function isSearchableTextNode(node: Node, boundary: HTMLElement): boolean {
  let element = node.parentElement;
  while (element) {
    const tag = element.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return false;
    if (
      element.hidden ||
      element.getAttribute('aria-hidden') === 'true' ||
      element.hasAttribute('data-search-exclude')
    ) {
      return false;
    }
    if (
      element.style.display === 'none' ||
      element.style.visibility === 'hidden' ||
      element.classList.contains('hidden') ||
      element.classList.contains('invisible')
    ) {
      return false;
    }
    if (element === boundary) break;
    element = element.parentElement;
  }
  return true;
}

/**
 * Scroll the given `Range` into the centre of the viewport unless it
 * already sits comfortably inside it. Uses instant (non-smooth)
 * scrolling so search navigation feels snappy.
 *
 * Note: `scrollIntoView` walks up through every scrollable ancestor,
 * so this works for nested scrollers (e.g. a preview body inside a
 * panel inside the page).
 */
export function scrollRangeIntoView(range: Range): void {
  const rect = range.getBoundingClientRect();
  const target = rect.top + rect.height / 2;
  const viewport = window.innerHeight;
  // `rect.width === 0` happens for ranges inside not-yet-laid-out
  // text (e.g. pdf.js text-layer spans before their first paint);
  // treat that as "needs scroll" so the parent element comes into
  // view and the next observer pass can refine the position.
  if (rect.width === 0 || target < 80 || target > viewport - 80) {
    range.startContainer.parentElement?.scrollIntoView({
      block: 'center',
      behavior: 'auto',
    });
  }
}

/**
 * Repeatedly try to find + scroll-to the n-th occurrence of `query`
 * inside `getRoot()`'s current value, retrying on every subtree
 * mutation until success or `timeoutMs` elapses.
 *
 * Needed because the preview content the user wants to jump into
 * mounts asynchronously:
 *   - Milkdown waits one frame after mount before rendering text.
 *   - pdf.js renders the text layer per-page after rasterising.
 *   - Office iframes mount inert and load on a delay.
 *
 * `getRoot` is a thunk (not a static element) so the caller can
 * keep returning the freshest mounted panel as React swaps it.
 *
 * Observer scope is **narrowed on the fly**: we start by watching
 * `document.body` (because the panel may not be mounted yet), and
 * as soon as `getRoot()` returns a real element we re-bind to it.
 * This is the difference between firing the rAF callback on every
 * keystroke / animation anywhere in the app and only firing it on
 * actual text-layer mounts inside the panel we care about.
 *
 * `onTimeout` fires when the watchdog elapses without ever landing
 * on a match — used by callers to surface a "couldn't locate the
 * match in this preview" hint instead of leaving the user wondering
 * why the panel didn't move.
 *
 * Returns a cancel function the caller should run when the
 * navigation intent changes (e.g. user clicks a different row).
 */
export function scheduleScrollToMatch(
  getRoot: () => HTMLElement | null,
  query: string,
  nth: number,
  options?: { timeoutMs?: number; onTimeout?: () => void },
): () => void {
  if (!query) return () => {};
  const timeoutMs = options?.timeoutMs ?? 8000;
  const onTimeout = options?.onTimeout;

  let cancelled = false;
  let observer: MutationObserver | null = null;
  let observedTarget: Node | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rafId = 0;
  let resolved = false;

  const cleanup = (): void => {
    observer?.disconnect();
    observer = null;
    observedTarget = null;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const tryScroll = (): boolean => {
    if (cancelled) return true;
    const root = getRoot();
    if (!root) return false;
    // Prefer the requested ordinal; fall back to the first match if
    // the DOM has fewer occurrences than the indexed content (e.g.
    // markdown source has matches in syntax tokens that the rendered
    // view strips, or pdf.js hasn't paginated all hits yet).
    const range =
      findNthRange(root, query, nth) ?? findNthRange(root, query, 0);
    if (!range) return false;
    scrollRangeIntoView(range);
    return true;
  };

  const onMutation: MutationCallback = () => {
    if (cancelled || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      // Narrow the observer to the panel root as soon as one exists.
      // Until then we have to listen on body — the panel might mount
      // in response to a `jumpToResult` call running in the same
      // tick this schedule was registered.
      ensureNarrowedObserver();
      if (tryScroll()) {
        resolved = true;
        cleanup();
      }
    });
  };

  const ensureNarrowedObserver = (): void => {
    const root = getRoot();
    const desired: Node = root ?? document.body;
    if (observedTarget === desired) return;
    observer?.disconnect();
    observer = new MutationObserver(onMutation);
    observer.observe(desired, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    observedTarget = desired;
  };

  if (tryScroll()) {
    return () => {
      cancelled = true;
    };
  }

  ensureNarrowedObserver();

  timer = setTimeout(() => {
    cleanup();
    if (!resolved && !cancelled) onTimeout?.();
  }, timeoutMs);

  return () => {
    cancelled = true;
    cleanup();
  };
}
