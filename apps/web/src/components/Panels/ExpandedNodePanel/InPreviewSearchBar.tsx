// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
 *      in `index.css` (`::highlight(huabu-search)`).
 *   2. A preview-local query consumed by adapters such as the PDF
 *      text index. It is deliberately independent from canvas-wide
 *      search state and never opens or updates the Layers panel.
 *
 * Esc closes the bar (the parent panel's existing Esc handler still
 * closes the panel itself when the bar is gone).
 */

import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePreviewSearchAdapter } from './PreviewSearchAdapterContext';
import { formatShortcutById } from '../../../config/shortcuts';
import { findNthRange, scrollRangeIntoView } from '../../../hooks/searchDom';
import { useTextHighlight } from '../../../hooks/useTextHighlight';
import { usePreviewSearchStore } from '../../../store/previewSearchStore';
import { Button } from '../../Common/Button';

interface InPreviewSearchBarProps {
  /** Root of the preview content. Highlights paint over its descendants. */
  scopeEl: HTMLElement | null;
  nodeId: string | null;
}

export const InPreviewSearchBar = ({
  scopeEl,
  nodeId,
}: InPreviewSearchBarProps): React.JSX.Element | null => {
  const { t } = useTranslation();
  const isOpen = usePreviewSearchStore((s) => s.isOpen);
  const ownerNodeId = usePreviewSearchStore((s) => s.nodeId);
  const query = usePreviewSearchStore((s) => s.query);
  const setQuery = usePreviewSearchStore((s) => s.setQuery);
  const close = usePreviewSearchStore((s) => s.close);
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const searchAdapter = usePreviewSearchAdapter();
  const isActive = isOpen && ownerNodeId === nodeId;

  useEffect(() => {
    if (isActive) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isActive]);

  // Preview search is a per-node session. When the owning node changes or
  // the panel unmounts, reset the shared store so reopening the same node
  // does not resurrect a stale query and steal focus on mount.
  useEffect(() => {
    return () => {
      usePreviewSearchStore.getState().close();
    };
  }, [nodeId]);

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
  //
  // Only paint when this node owns preview search. Canvas-wide search
  // deliberately excludes the preview body, so the two surfaces never
  // compete for query or highlight ownership.
  const { matchCount: domMatchCount } = useTextHighlight({
    container: isActive ? scopeEl : null,
    query,
  });
  const matchCount = searchAdapter?.matchCount ?? domMatchCount;

  // Reset cursor whenever the query changes so Next/Prev starts from top.
  useEffect(() => {
    setActiveMatchIdx(0);
    setHasNavigated(false);
  }, [query]);

  const jumpToMatch = (idx: number): void => {
    if (
      !scopeEl ||
      !query ||
      matchCount === 0 ||
      (searchAdapter && !searchAdapter.canNavigate)
    )
      return;
    const normalised = ((idx % matchCount) + matchCount) % matchCount;
    setActiveMatchIdx(normalised);
    setHasNavigated(true);
    if (searchAdapter) {
      searchAdapter.navigateToMatch(normalised);
      return;
    }
    const range = findNthRange(scopeEl, query, normalised);
    if (range) scrollRangeIntoView(range);
  };

  if (!isActive) return null;

  return (
    <div
      role="presentation"
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
        placeholder={t('search.findPlaceholder')}
        onChange={(e) => setQuery(e.target.value)}
        className="placeholder:text-fg-subtle text-fg-default w-44 min-w-0 bg-transparent px-1 text-sm outline-none"
      />
      <span className="text-fg-subtle shrink-0 px-1 text-[11px] tabular-nums">
        {query.length > 0
          ? matchCount > 0
            ? `${activeMatchIdx + 1}/${matchCount}${searchAdapter?.isSearching ? '+' : ''}`
            : searchAdapter?.isSearching
              ? '…'
              : '0/0'
          : ''}
      </span>
      <Button
        variant="ghost"
        iconOnly
        size="sm"
        title={`${t('search.previousMatch')} (${formatShortcutById('search.previousMatch')})`}
        disabled={
          matchCount === 0 || (!!searchAdapter && !searchAdapter.canNavigate)
        }
        onClick={() => jumpToMatch(activeMatchIdx - 1)}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        iconOnly
        size="sm"
        title={`${t('search.nextMatch')} (${formatShortcutById('search.jumpResult')})`}
        disabled={
          matchCount === 0 || (!!searchAdapter && !searchAdapter.canNavigate)
        }
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
        title={`${t('actions.close')} (${formatShortcutById('search.close')})`}
        onClick={close}
      >
        <X />
      </Button>
    </div>
  );
};
