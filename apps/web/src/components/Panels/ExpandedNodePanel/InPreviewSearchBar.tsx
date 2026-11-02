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
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePreviewSearchAdapter } from './PreviewSearchAdapterContext';
import { formatShortcutById } from '../../../config/shortcuts';
import {
  findNthRange,
  scheduleScrollToMatch,
  scrollRangeIntoView,
  getRangeMatchIndex,
} from '../../../hooks/searchDom';
import { useTextHighlight } from '../../../hooks/useTextHighlight';
import { usePreviewSearchStore } from '../../../store/previewSearchStore';
import { Button } from '../../Common/Button';
import { toast } from '../../Common/Toast';

interface InPreviewSearchBarProps {
  /** Root of the preview content. Highlights paint over its descendants. */
  scopeEl: HTMLElement | null;
  nodeId: string | null;
  requiresAdapter?: boolean;
}

export const InPreviewSearchBar = ({
  scopeEl,
  nodeId,
  requiresAdapter = false,
}: InPreviewSearchBarProps): React.JSX.Element | null => {
  const { t } = useTranslation();
  const isOpen = usePreviewSearchStore((s) => s.isOpen);
  const ownerNodeId = usePreviewSearchStore((s) => s.nodeId);
  const query = usePreviewSearchStore((s) => s.query);
  const setQuery = usePreviewSearchStore((s) => s.setQuery);
  const close = usePreviewSearchStore((s) => s.close);
  const focusInput = usePreviewSearchStore((s) => s.focusInput);
  const navigationRequest = usePreviewSearchStore((s) => s.navigationRequest);
  const rendererOwner = usePreviewSearchStore((s) => s.rendererOwner);
  const [rendererId] = useState(() => Symbol('preview-search-renderer'));
  const inputRef = useRef<HTMLInputElement>(null);
  const manualNavigationRef = useRef<{
    cancel?: () => void;
  } | null>(null);
  const cancelManualNavigation = useCallback(() => {
    const pending = manualNavigationRef.current;
    manualNavigationRef.current = null;
    pending?.cancel?.();
  }, []);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const [selectedRange, setSelectedRange] = useState<{
    query: string;
    range: Range;
  } | null>(null);
  const registeredAdapter = usePreviewSearchAdapter();
  const searchAdapter =
    registeredAdapter?.query === query ? registeredAdapter : null;
  const isActive =
    isOpen && ownerNodeId === nodeId && rendererOwner === rendererId;
  const getActiveRange = useCallback(
    () => searchAdapter?.getMatchRange?.(activeMatchIdx) ?? null,
    [searchAdapter, activeMatchIdx],
  );

  useEffect(() => {
    if (!isActive || !scopeEl) return;
    const chat = scopeEl.matches('[data-chat-thread-root]')
      ? scopeEl
      : scopeEl.querySelector('[data-chat-thread-root]');
    chat?.dispatchEvent(new Event('chat-find-open'));
    return () => {
      chat?.dispatchEvent(new Event('chat-find-close'));
    };
  }, [isActive, scopeEl]);

  useEffect(() => {
    if (isActive && focusInput) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isActive, focusInput]);

  useEffect(() => {
    if (!nodeId) return;
    return usePreviewSearchStore
      .getState()
      .registerRenderer(nodeId, rendererId);
  }, [nodeId, rendererId]);

  useEffect(() => {
    const unsubscribe = usePreviewSearchStore.subscribe((state, previous) => {
      if (
        state.query !== previous.query ||
        state.nodeId !== previous.nodeId ||
        state.isOpen !== previous.isOpen ||
        state.rendererOwner !== previous.rendererOwner ||
        state.navigationSequence !== previous.navigationSequence
      )
        cancelManualNavigation();
    });
    return () => {
      unsubscribe();
      cancelManualNavigation();
    };
  }, [cancelManualNavigation, isActive, query, nodeId, scopeEl, searchAdapter]);

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
    activeMatchIndex: activeMatchIdx,
    activeRange: selectedRange?.query === query ? selectedRange.range : null,
    getActiveRange,
  });
  const waitingForAdapter = requiresAdapter && !searchAdapter;
  const matchCount = waitingForAdapter
    ? 0
    : (searchAdapter?.matchCount ?? domMatchCount);
  const isSearching = waitingForAdapter || searchAdapter?.isSearching;

  // Reset cursor whenever the query changes so Next/Prev starts from top.
  useEffect(() => {
    setActiveMatchIdx(0);
    setHasNavigated(false);
    setSelectedRange(null);
  }, [query]);

  useEffect(() => {
    if (!isActive || !navigationRequest || (!waitingForAdapter && !isSearching))
      return;
    const { nonce } = navigationRequest;
    const timer = setTimeout(() => {
      if (usePreviewSearchStore.getState().navigationRequest?.nonce !== nonce)
        return;
      toast(t('search.previewMatchNotVisible'), {
        tone: 'info',
        duration: 4000,
      });
      usePreviewSearchStore.getState().consumeNavigation(nonce);
    }, 8000);
    return () => clearTimeout(timer);
  }, [isActive, navigationRequest, waitingForAdapter, isSearching, t]);

  useEffect(() => {
    if (
      !isActive ||
      !navigationRequest ||
      !scopeEl ||
      !query ||
      waitingForAdapter
    )
      return;
    const { occurrenceIndex, nonce } = navigationRequest;
    const consume = () =>
      usePreviewSearchStore.getState().consumeNavigation(nonce);
    if (searchAdapter) {
      if (!searchAdapter.isCurrent()) return;
      if (
        !searchAdapter.failed &&
        (!searchAdapter.canNavigate || searchAdapter.isSearching)
      )
        return;
      let cancelled = false;
      let cancelNavigation: (() => void) | void;
      const finish = (visible: boolean, index: number, range?: Range): void => {
        if (
          cancelled ||
          !searchAdapter.isCurrent() ||
          usePreviewSearchStore.getState().navigationRequest?.nonce !== nonce
        )
          return;
        if (visible) {
          setActiveMatchIdx(index);
          setHasNavigated(true);
          setSelectedRange(range ? { query, range } : null);
        } else {
          toast(t('search.previewMatchNotVisible'), {
            tone: 'info',
            duration: 4000,
          });
        }
        consume();
      };
      const navigate = (index: number | null): void => {
        if (cancelled || !searchAdapter.isCurrent()) return;
        if (index === null || index < 0 || index >= searchAdapter.matchCount)
          finish(false, 0);
        else
          cancelNavigation = searchAdapter.navigateToMatch(
            index,
            (visible, range) => finish(visible, index, range),
          );
      };
      if (searchAdapter.failed) finish(false, 0);
      else if (navigationRequest.source) {
        if (!searchAdapter.resolveSourceMatch) navigate(null);
        else
          void searchAdapter
            .resolveSourceMatch(navigationRequest.source)
            .then(navigate)
            .catch((error: unknown) => {
              console.error(
                '[search] Cannot resolve indexed source match',
                error,
              );
              finish(false, 0);
            });
      } else navigate(occurrenceIndex);
      return () => {
        cancelled = true;
        cancelNavigation?.();
      };
    }
    return scheduleScrollToMatch(() => scopeEl, query, occurrenceIndex, {
      source: navigationRequest.source,
      fallbackToFirst: false,
      onMatch: (range) => {
        setSelectedRange({ query, range });
        setActiveMatchIdx(getRangeMatchIndex(scopeEl, query, range) ?? 0);
        setHasNavigated(true);
        consume();
      },
      onTimeout: () => {
        toast(t('search.previewMatchNotVisible'), {
          tone: 'info',
          duration: 4000,
        });
        consume();
      },
    });
  }, [
    isActive,
    navigationRequest,
    scopeEl,
    query,
    searchAdapter,
    waitingForAdapter,
    t,
  ]);

  const jumpToMatch = (idx: number): void => {
    if (
      !scopeEl ||
      !query ||
      matchCount === 0 ||
      (searchAdapter &&
        (!searchAdapter.isCurrent() || !searchAdapter.canNavigate))
    )
      return;
    cancelManualNavigation();
    const normalised = ((idx % matchCount) + matchCount) % matchCount;
    if (navigationRequest)
      usePreviewSearchStore
        .getState()
        .consumeNavigation(navigationRequest.nonce);
    const pending: { cancel?: () => void } = {};
    manualNavigationRef.current = pending;
    const sequence = usePreviewSearchStore.getState().navigationSequence;
    const finish = (visible: boolean, range?: Range): void => {
      const state = usePreviewSearchStore.getState();
      if (
        manualNavigationRef.current !== pending ||
        !state.isOpen ||
        state.nodeId !== nodeId ||
        state.query !== query ||
        state.rendererOwner !== rendererId ||
        state.navigationSequence !== sequence ||
        (searchAdapter && !searchAdapter.isCurrent())
      )
        return;
      manualNavigationRef.current = null;
      if (visible) {
        setActiveMatchIdx(normalised);
        setHasNavigated(true);
        setSelectedRange(range ? { query, range } : null);
      } else
        toast(t('search.previewMatchNotVisible'), {
          tone: 'info',
          duration: 4000,
        });
    };
    if (searchAdapter) {
      const cancel = searchAdapter.navigateToMatch(normalised, finish);
      if (manualNavigationRef.current === pending)
        pending.cancel = cancel || undefined;
      else cancel?.();
      return;
    }
    const range = findNthRange(scopeEl, query, normalised);
    finish(!!range && scrollRangeIntoView(range), range ?? undefined);
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
            ? `${activeMatchIdx + 1}/${matchCount}${isSearching ? '+' : ''}`
            : isSearching
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
