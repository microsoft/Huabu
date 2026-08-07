// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas-wide search input, hosted at the top of the left layer
 * panel and only mounted while `panelStore.isSearchOpen` is true.
 *
 * Toggleable on purpose: the panel chrome stays quiet for users
 * who never search; the input is revealed by the search icon in
 * `LayerFilterBar` or by the global `Cmd+F` hotkey, and dismissed
 * by clicking the icon again, by `Esc`, or by closing the parent
 * panel. While mounted it replaces nothing else — the chip row
 * below stays visible so chip toggles can narrow / widen the
 * search request live (see `searchStore.nodeTypes`).
 *
 * Wiring:
 *   - Writes go to `searchStore.setQuery`. On the first non-empty
 *     character (or on Cmd+F focus) we ensure the store's `scope`
 *     is `{kind:'canvas', canvasId}` so the streamed request is
 *     scoped to the active canvas.
 *   - Mount: auto-focuses the input so both the icon-click and the
 *     Cmd+F hotkey paths land the caret in the right place without
 *     each having to chase the DOM separately.
 *   - Esc: cancels in-flight request, clears query, flips
 *     `isSearchOpen=false` (unmounts this component), and returns
 *     keyboard focus to the React Flow canvas so the next key goes
 *     where the user expects.
 *   - Unmount: also closes the store scope, so a future re-open
 *     starts from an empty query without stale results lingering
 *     under the hidden component.
 *   - Switching canvases closes the store scope (effect below),
 *     which collapses the result list and restores the layer tree
 *     without an extra keystroke.
 */

import { Loader2, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { formatShortcutById } from '../../../config/shortcuts';
import useCanvasStore from '../../../store/canvasStore';
import { usePanelStore } from '../../../store/panelStore';
import { useSearchStore } from '../../../store/searchStore';
import { Button } from '../../Common/Button';
import { cn } from '../../Common/cn';

interface CanvasSearchInputProps {
  inputRef?: React.RefObject<HTMLInputElement>;
}

/**
 * Centralised "make sure the search store is scoped to the active
 * canvas" guard. Re-entering an active canvas scope is a no-op so
 * this is safe to call before every mutation that depends on scope
 * being set (typing, Cmd+F focus).
 */
export function ensureCanvasSearchScope(canvasId: string | null): void {
  if (!canvasId) return;
  const s = useSearchStore.getState();
  if (s.scope?.kind === 'canvas' && s.scope.canvasId === canvasId) return;
  s.open({ kind: 'canvas', canvasId });
}

export const CanvasSearchInput = ({
  inputRef: externalRef,
}: CanvasSearchInputProps): React.JSX.Element => {
  const { t } = useTranslation();
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? localRef;

  const canvasId = useCanvasStore((s) => s.canvasId);
  const query = useSearchStore((s) => s.query);
  const isStreaming = useSearchStore((s) => s.isStreaming);
  const results = useSearchStore((s) => s.results);
  const scope = useSearchStore((s) => s.scope);
  const error = useSearchStore((s) => s.error);
  const setQuery = useSearchStore((s) => s.setQuery);
  const close = useSearchStore((s) => s.close);
  const setSearchOpen = usePanelStore((s) => s.setSearchOpen);

  // The store's scope is per-canvas. If the user switches canvases
  // while a search is active, drop scope (which also cancels the
  // in-flight request and clears `results`) so the result list
  // below doesn't render stale rows for the previous canvas. The
  // input itself stays mounted because it lives in the panel.
  useEffect(() => {
    if (scope && scope.canvasId !== canvasId) close();
  }, [scope, canvasId, close]);

  // Auto-focus + select on mount. Both entry points (toolbar icon
  // click via `toggleSearchOpen`, and the global `Cmd+F` hotkey)
  // converge on "mount the component" — letting the component
  // itself drive focus means neither caller has to chase the DOM
  // separately, and there's no race between the React render and
  // the imperative focus() call.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
    // Intentionally run-once on mount: subsequent re-renders
    // shouldn't yank focus away if the user has tabbed elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Unmount cleanup: dismissing the input (via Esc or icon toggle)
  // should also reset the store scope so the next reveal starts
  // from an empty query rather than re-running a stale request the
  // moment the component re-mounts. Safe to call unconditionally
  // because `close()` on an already-closed store is a no-op.
  useEffect(() => {
    return () => {
      useSearchStore.getState().close();
    };
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      ensureCanvasSearchScope(canvasId);
      setQuery(e.target.value);
    },
    [canvasId, setQuery],
  );

  const handleClear = useCallback(() => {
    // Mirror Esc: clear query + close scope; leave focus on the
    // input so the user can keep typing in the (now empty) input
    // or tab away as they wish.
    close();
    inputRef.current?.focus();
  }, [close, inputRef]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Dismiss the input entirely: clear store state + flip the
        // panel-side `isSearchOpen` so this component unmounts. The
        // unmount cleanup above will also call `close()` — calling
        // it here first is harmless and keeps the visual reset
        // synchronous (results disappear before the unmount
        // animation runs, avoiding a one-frame flash).
        close();
        setSearchOpen(false);
        // Return keyboard focus to the canvas so the next key
        // (e.g. arrow nav, Space to pan) goes where the user
        // expects after dismissing search. `data-canvas-root` is
        // tagged on the React Flow wrapper for exactly this kind
        // of focus hand-off.
        const root = document.querySelector<HTMLElement>('[data-canvas-root]');
        root?.focus();
      }
    },
    [close, setSearchOpen],
  );

  // The "count" badge mirrors the centred overlay's UX: while the
  // request is streaming we show the live count next to a spinner;
  // once `isStreaming` flips false the spinner disappears but the
  // final count stays visible. Hidden when there's nothing to
  // count (empty query / no results yet) so the chrome stays
  // minimal in the dormant state.
  const showCount = query.length > 0 && results.length > 0;

  return (
    <div
      className={cn(
        'bg-bg-default flex items-center gap-1.5 rounded-md border px-1.5 transition-colors',
        error ? 'border-danger' : 'focus-within:border-info border-transparent',
      )}
    >
      <Search size={12} className="text-fg-subtle shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={t('layers.searchPlaceholder')}
        spellCheck={false}
        className="text-fg-default placeholder:text-fg-subtle min-w-0 flex-1 bg-transparent py-1 text-xs outline-none"
        data-canvas-search-input="true"
        aria-label={t('layers.searchAria')}
      />
      {isStreaming && (
        <Loader2
          size={11}
          className="text-fg-subtle shrink-0 animate-spin"
          aria-label={t('search.searching')}
        />
      )}
      {showCount && (
        <span className="text-fg-subtle shrink-0 text-[11px] tabular-nums">
          {results.length}
        </span>
      )}
      {query.length > 0 && (
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          title={`${t('search.clear')} (${formatShortcutById('search.close')})`}
          onClick={handleClear}
          className="p-0.5!"
        >
          <X size={11} />
        </Button>
      )}
    </div>
  );
};
