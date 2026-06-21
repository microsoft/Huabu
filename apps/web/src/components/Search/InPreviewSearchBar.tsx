/**
 * In-preview find bar — the search surface for `ExpandedNodePanel`.
 *
 * Floats as a small panel pinned to the **top-right corner of the
 * preview body** (VS Code style), so the preview content underneath
 * stays fully visible and the find widget doesn't reflow the
 * document the user is searching. Triggered by Cmd+F while focus is
 * inside the preview.
 *
 * Drives two things in parallel:
 *
 *   1. {@link useTextHighlight} on the preview DOM — paints inline
 *      `::highlight()` ranges over all visible matches without
 *      mutating Milkdown / pdf.js text nodes. The paint rule lives
 *      in `index.css` (`::highlight(sediment-search)`).
 *   2. Optional: a server-side `nodeId`-restricted search query so
 *      the count and "Next / Prev" navigation can address matches
 *      outside the visible viewport (e.g. inside a collapsed Milkdown
 *      block). For v1 we rely on the inline DOM walk for count + nav
 *      — the server call is reserved for a follow-up that adds
 *      jump-to-PDF-page support.
 *
 * Esc closes the bar (the parent panel's existing Esc handler still
 * closes the panel itself when the bar is gone).
 */

import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useTextHighlight } from '../../hooks/useTextHighlight';
import { useSearchStore } from '../../store/searchStore';
import { Button } from '../Common/Button';

interface InPreviewSearchBarProps {
  /** Root of the preview content. Highlights paint over its descendants. */
  scopeEl: HTMLElement | null;
}

export const InPreviewSearchBar = ({
  scopeEl,
}: InPreviewSearchBarProps): JSX.Element | null => {
  const scope = useSearchStore((s) => s.scope);
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const close = useSearchStore((s) => s.close);
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);

  const isNodeScope = scope?.kind === 'node';

  useEffect(() => {
    if (isNodeScope) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isNodeScope]);

  // Track whether the user has already navigated at least once. The
  // inline highlight visually implies the first match is "current", so
  // the first Enter should jump TO match #1, not to match #2. We model
  // this by treating the initial cursor as "not yet navigated" and
  // only incrementing on subsequent presses.
  const [hasNavigated, setHasNavigated] = useState(false);

  // Live highlight on the preview body via CSS Custom Highlight API.
  // The hook also exposes the live match count — kept in sync with the
  // same MutationObserver that re-paints highlights, so the "n/m"
  // readout below stays accurate as pdf.js / Milkdown mount text
  // asynchronously.
  const { matchCount } = useTextHighlight({ container: scopeEl, query });

  // Reset cursor whenever the query changes so Next/Prev starts from top.
  useEffect(() => {
    setActiveMatchIdx(0);
    setHasNavigated(false);
  }, [query]);

  const jumpToMatch = (idx: number): void => {
    if (!scopeEl || !query || matchCount === 0) return;
    const normalised = ((idx % matchCount) + matchCount) % matchCount;
    setActiveMatchIdx(normalised);
    setHasNavigated(true);
    const range = findNthRange(scopeEl, query, normalised);
    if (range) {
      // Scroll the match centre into view, no smooth so it's snappy.
      const rect = range.getBoundingClientRect();
      const target = rect.top + rect.height / 2;
      const viewport = window.innerHeight;
      if (target < 80 || target > viewport - 80) {
        range.startContainer.parentElement?.scrollIntoView({
          block: 'center',
          behavior: 'auto',
        });
      }
    }
  };

  if (!isNodeScope) return null;

  return (
    <div
      className="border-edge-default bg-surface absolute top-3 right-3 z-50 flex h-9 items-center gap-1 rounded-lg border px-1.5 shadow-lg"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Stop the native event from bubbling to the window-level
          // Escape listener in ExpandedNodePanel — pressing Esc on
          // the find bar should close the bar only, not also close
          // the surrounding preview panel.
          e.preventDefault();
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          close();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          // First Enter scrolls TO match #1 (cursor is already on it
          // visually); subsequent presses step forward / backward.
          const delta = e.shiftKey ? -1 : 1;
          const target = hasNavigated ? activeMatchIdx + delta : activeMatchIdx;
          jumpToMatch(target);
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="Find…"
        onChange={(e) => setQuery(e.target.value)}
        className="placeholder:text-fg-subtle text-fg-default w-44 min-w-0 bg-transparent px-1 text-sm outline-none"
      />
      <span className="text-fg-subtle shrink-0 px-1 text-[11px] tabular-nums">
        {query.length > 0
          ? matchCount > 0
            ? `${activeMatchIdx + 1}/${matchCount}`
            : '0/0'
          : ''}
      </span>
      <Button
        variant="ghost"
        iconOnly
        size="sm"
        title="Previous match (Shift+Enter)"
        disabled={matchCount === 0}
        onClick={() => jumpToMatch(activeMatchIdx - 1)}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        iconOnly
        size="sm"
        title="Next match (Enter)"
        disabled={matchCount === 0}
        onClick={() => jumpToMatch(activeMatchIdx + 1)}
      >
        <ChevronDown />
      </Button>
      <Button
        variant="solid"
        tone="neutral"
        shape="pill"
        iconOnly
        size="sm"
        className="p-0.5"
        title="Close (Esc)"
        onClick={close}
      >
        <X />
      </Button>
    </div>
  );
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function findNthRange(
  root: HTMLElement,
  query: string,
  nth: number,
): Range | null {
  const needle = query.toLowerCase();
  if (!needle) return null;
  let remaining = nth;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const text = (current.textContent ?? '').toLowerCase();
    let from = 0;
    while (true) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      if (remaining === 0) {
        const range = document.createRange();
        range.setStart(current, idx);
        range.setEnd(current, idx + needle.length);
        return range;
      }
      remaining -= 1;
      from = idx + Math.max(1, needle.length);
    }
    current = walker.nextNode();
  }
  return null;
}
