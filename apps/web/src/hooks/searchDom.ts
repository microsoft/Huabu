// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { literalTextMatches } from '@huabu/shared';

import { resolveSourceRange } from './useSearchSource';

import type { CanvasSearchSource } from '@huabu/shared';

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
 * Walks in document order. Each `[data-search-renderer]` scopes its own
 * searchable document without excluding sibling content in a larger root.
 * Hidden content and explicitly excluded chrome are always skipped.
 */
export function findNthRange(
  root: HTMLElement,
  query: string,
  nth: number,
): Range | null {
  let index = 0;
  for (const { node, offset, endNode, endOffset } of walkTextMatches(
    root,
    query,
  )) {
    if (index++ !== nth) continue;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(endNode, endOffset);
    return range;
  }
  return null;
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
  const ranges: Range[] = [];
  if (maxRanges <= 0) return ranges;
  for (const { node, offset, endNode, endOffset } of walkTextMatches(
    root,
    query,
  )) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(endNode, endOffset);
    ranges.push(range);
    if (ranges.length >= maxRanges) break;
  }
  return ranges;
}

/** Count all searchable occurrences without allocating DOM Range objects. */
export function countMatches(root: HTMLElement, query: string): number {
  let count = 0;
  const matches = walkTextMatches(root, query);
  while (!matches.next().done) count += 1;
  return count;
}

export function getRangeMatchIndex(
  root: HTMLElement,
  query: string,
  range: Range,
): number | null {
  let index = 0;
  for (const match of walkTextMatches(root, query)) {
    if (
      match.node === range.startContainer &&
      match.offset === range.startOffset &&
      match.endNode === range.endContainer &&
      match.endOffset === range.endOffset
    )
      return index;
    index++;
  }
  return null;
}

function searchableTextNodes(root: HTMLElement): Node[] {
  const nodes: Node[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  let current = walker.nextNode();
  while (current) {
    if (
      current.nodeType === Node.TEXT_NODE &&
      isSearchableTextNode(current, root)
    )
      nodes.push(current);
    current = walker.nextNode();
  }
  return nodes;
}

export function findProjectedRange(
  root: HTMLElement,
  source: string,
  start: number,
  end: number,
): Range | null {
  const nodes = searchableTextNodes(root);
  const compact = (text: string): string => text.replace(/\s/g, '');
  if (
    compact(nodes.map((node) => node.textContent ?? '').join('')) !==
    compact(source)
  )
    return null;
  const from = compact(source.slice(0, start)).length;
  const to = compact(source.slice(0, end)).length;
  if (from === to) return null;
  const range = document.createRange();
  let index = 0;
  let started = false;
  for (const node of nodes) {
    const text = node.textContent ?? '';
    for (let offset = 0; offset < text.length; offset++) {
      if (/\s/.test(text[offset] ?? '')) continue;
      if (index === from) {
        range.setStart(node, offset);
        started = true;
      }
      index++;
      if (started && index === to) {
        range.setEnd(node, offset + 1);
        return range;
      }
    }
  }
  return null;
}

function* walkTextMatches(
  root: HTMLElement,
  query: string,
): Generator<{ node: Node; offset: number; endNode: Node; endOffset: number }> {
  const needle = query.toLowerCase();
  if (!needle) return;
  const nodes = searchableTextNodes(root);
  let text = '';
  let previousBlock: Element | null | undefined;
  const spans = nodes.map((node) => {
    const block = node.parentElement?.closest(
      'p,div,li,pre,td,th,h1,h2,h3,h4,h5,h6',
    );
    if (previousBlock !== undefined && block !== previousBlock) text += '\0';
    previousBlock = block;
    const start = text.length;
    text += node.textContent ?? '';
    return { node, start, end: text.length };
  });
  let spanIndex = 0;
  for (const { start: index, end: matchEnd } of literalTextMatches(
    text,
    needle,
  )) {
    while (spanIndex < spans.length && (spans[spanIndex]?.end ?? 0) <= index)
      spanIndex++;
    const start = spans[spanIndex];
    let endIndex = spanIndex;
    while (endIndex < spans.length && (spans[endIndex]?.end ?? 0) < matchEnd)
      endIndex++;
    const end = spans[endIndex];
    if (start && end)
      yield {
        node: start.node,
        offset: index - start.start,
        endNode: end.node,
        endOffset: matchEnd - end.start,
      };
  }
}

function isSearchableTextNode(node: Node, boundary: HTMLElement): boolean {
  const renderer = node.parentElement?.closest('[data-search-renderer]');
  const content = node.parentElement?.closest('[data-preview-search-content]');
  if (renderer && (!content || !renderer.contains(content))) return false;
  let element = node.parentElement;
  while (element) {
    const tag = element.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return false;
    if (
      element.hidden ||
      element.getAttribute('aria-hidden') === 'true' ||
      element.getAttribute('data-preview-active') === 'false' ||
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
 * Scroll each ancestor by the Range geometry, never by the dimensions
 * of its potentially much taller parent paragraph.
 */
export function scrollRangeIntoView(range: Range): boolean {
  let rect = range.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  for (
    let parent = range.startContainer.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    if (!bounds.height || !bounds.width) continue;
    const inset = Math.min(80, bounds.height / 4);
    if (
      /(auto|scroll|hidden|clip)/.test(style.overflowY) &&
      (rect.top < bounds.top + inset || rect.bottom > bounds.bottom - inset)
    ) {
      parent.scrollTop +=
        rect.top + rect.height / 2 - bounds.top - bounds.height / 2;
      rect = range.getBoundingClientRect();
    }
    if (
      /(auto|scroll|hidden|clip)/.test(style.overflowX) &&
      (rect.left < bounds.left || rect.right > bounds.right)
    ) {
      parent.scrollLeft +=
        rect.left + rect.width / 2 - bounds.left - bounds.width / 2;
      rect = range.getBoundingClientRect();
    }
  }
  if (
    rect.top < 0 ||
    rect.bottom > window.innerHeight ||
    rect.left < 0 ||
    rect.right > window.innerWidth
  ) {
    window.scrollBy({
      top: rect.top + rect.height / 2 - window.innerHeight / 2,
      left:
        rect.left < 0 || rect.right > window.innerWidth
          ? rect.left + rect.width / 2 - window.innerWidth / 2
          : 0,
      behavior: 'instant',
    });
    rect = range.getBoundingClientRect();
  }
  let visibleTop = 0;
  let visibleBottom = window.innerHeight;
  let visibleLeft = 0;
  let visibleRight = window.innerWidth;
  for (
    let parent = range.startContainer.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    if (bounds.height === 0) continue;
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      visibleTop = Math.max(visibleTop, bounds.top);
      visibleBottom = Math.min(visibleBottom, bounds.bottom);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      visibleLeft = Math.max(visibleLeft, bounds.left);
      visibleRight = Math.min(visibleRight, bounds.right);
    }
  }
  const visible = (
    start: number,
    end: number,
    clipStart: number,
    clipEnd: number,
  ): boolean =>
    end - start <= clipEnd - clipStart
      ? start >= clipStart - 0.5 && end <= clipEnd + 0.5
      : (start + end) / 2 >= clipStart && (start + end) / 2 <= clipEnd;
  return (
    visibleBottom > visibleTop &&
    visibleRight > visibleLeft &&
    visible(rect.top, rect.bottom, visibleTop, visibleBottom) &&
    visible(rect.left, rect.right, visibleLeft, visibleRight)
  );
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
  options?: {
    timeoutMs?: number;
    onTimeout?: () => void;
    onMatch?: (range: Range) => void;
    fallbackToFirst?: boolean;
    getMatchRoot?: (root: HTMLElement) => HTMLElement | null;
    source?: CanvasSearchSource;
    requireSource?: boolean;
    getMatchRange?: (root: HTMLElement) => Range | null;
  },
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
  let waitingForLayout = false;
  const preparedChatRoots = new WeakSet<HTMLElement>();
  let preparedChatRoot: HTMLElement | null = null;

  const cleanup = (): void => {
    preparedChatRoot?.dispatchEvent(new Event('chat-search-finished'));
    preparedChatRoot = null;
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
    waitingForLayout = false;
    if (cancelled) return true;
    const root = getRoot();
    if (!root) return false;
    if (root.matches('[data-chat-thread-root]')) {
      if (root.closest('[data-preview-active="false"]')) return false;
      if (!preparedChatRoots.has(root)) {
        const request = new CustomEvent('chat-reveal-search', {
          cancelable: true,
          detail: { source: options?.source },
        });
        root.dispatchEvent(request);
        if (!request.defaultPrevented) return false;
        preparedChatRoots.add(root);
        preparedChatRoot = root;
      }
      if (
        root.hasAttribute('data-chat-cached-earlier') ||
        (root.hasAttribute('data-chat-has-older') &&
          !root.hasAttribute('data-chat-virtual-search')) ||
        root.hasAttribute('data-chat-history-loading')
      )
        return false;
    }
    const matchRoot = options?.getMatchRoot ? options.getMatchRoot(root) : root;
    if (!matchRoot) return false;
    if (options?.requireSource && !options.source) {
      onTimeout?.();
      return true;
    }
    const sourceMatch = options?.source
      ? resolveSourceRange(
          matchRoot,
          query,
          options.source,
          searchableTextNodes,
        )
      : null;
    if (sourceMatch?.unavailable) {
      onTimeout?.();
      return true;
    }
    // Document source ordinals can differ from rendered Markdown. Conversation
    // ordinals must never fall back to an unrelated, more recent occurrence.
    const range = options?.getMatchRange
      ? options.getMatchRange(matchRoot)
      : sourceMatch
        ? sourceMatch.range
        : (findNthRange(matchRoot, query, nth) ??
          (root.matches('[data-chat-thread-root]') ||
          options?.fallbackToFirst === false
            ? null
            : findNthRange(matchRoot, query, 0)));
    if (!range) return false;
    if (!scrollRangeIntoView(range)) {
      waitingForLayout = true;
      return false;
    }
    options?.onMatch?.(range);
    return true;
  };

  const onMutation = (): void => {
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
      } else if (waitingForLayout) onMutation();
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
      attributes: true,
      attributeFilter: [
        'data-chat-cached-earlier',
        'data-chat-has-older',
        'data-chat-history-loading',
        'data-preview-active',
        'data-search-source',
        'data-search-source-ready',
      ],
    });
    observedTarget = desired;
  };

  if (tryScroll()) {
    cleanup();
    return () => {
      cancelled = true;
    };
  }

  ensureNarrowedObserver();
  if (waitingForLayout) onMutation();

  timer = setTimeout(() => {
    cleanup();
    if (!resolved && !cancelled) onTimeout?.();
  }, timeoutMs);

  return () => {
    cancelled = true;
    cleanup();
  };
}
