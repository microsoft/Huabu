// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Permanent Canvas-wide search field above the Layers filters.
 * Mounting or manually expanding Layers never steals focus; explicit
 * Cmd/Ctrl+F requests focus after the panel becomes interactive.
 * Escape clears the search and returns focus to Canvas without hiding
 * the field. Collapse retains the session; Space changes and unmount
 * close the scope and cancel pending requests.
 */

import { Loader2, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { formatShortcutById, getShortcutKeys } from '../../../config/shortcuts';
import useCanvasStore from '../../../store/canvasStore';
import { usePanelStore } from '../../../store/panelStore';
import { useSearchStore } from '../../../store/searchStore';
import { isMac, shortcutTokens } from '../../../utils/platform';
import { Button } from '../../Common/Button';
import { cn } from '../../Common/cn';
import { TextInput } from '../../Common/TextInput';

interface CanvasSearchInputProps {
  inputRef?: React.RefObject<HTMLInputElement>;
}

const searchShortcutKeys = getShortcutKeys('search.open');
if (!searchShortcutKeys)
  throw new Error('Missing search.open shortcut definition');
const searchShortcutTokens = shortcutTokens(searchShortcutKeys);

/**
 * Centralised "make sure the search store is scoped to the active
 * canvas" guard. Re-entering an active canvas scope is a no-op.
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
  const isLeftCollapsed = usePanelStore((s) => s.isLeftCollapsed);
  const focusRequest = usePanelStore((s) => s.focusCanvasSearchRequest);

  // The store's scope is per-canvas. If the user switches canvases
  // while a search is active, drop scope (which also cancels the
  // in-flight request and clears `results`) so the result list
  // below doesn't render stale rows for the previous canvas. The
  // input itself stays mounted because it lives in the panel.
  useEffect(() => {
    if (scope && scope.canvasId !== canvasId) close();
  }, [scope, canvasId, close]);

  useEffect(() => {
    if (focusRequest === null || isLeftCollapsed) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
    usePanelStore.setState({ focusCanvasSearchRequest: null });
  }, [focusRequest, isLeftCollapsed, inputRef]);

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
    close();
    inputRef.current?.focus({ preventScroll: true });
  }, [close, inputRef]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        const root =
          document.querySelector<HTMLElement>('[data-canvas-root]') ??
          document.querySelector<HTMLElement>('[data-center-editor]') ??
          document.querySelector<HTMLElement>(
            '[data-canvas-panel="right"]:not([data-collapsed])',
          );
        root?.focus({ preventScroll: true });
      }
    },
    [close],
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
        'bg-surface flex h-8 items-center gap-2 rounded-lg border px-2 transition-colors',
        error
          ? 'border-danger'
          : 'border-edge-default focus-within:border-info',
      )}
    >
      <Search size={14} className="text-fg-subtle shrink-0" />
      <TextInput
        ref={inputRef}
        type="text"
        name="canvas-search"
        autoComplete="off"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={t('layers.searchPlaceholder')}
        spellCheck={false}
        className="min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 py-1 text-sm font-normal placeholder:text-xs placeholder:font-normal focus:ring-0"
        data-canvas-search-input="true"
        data-search-scope="canvas"
        aria-label={t('layers.searchAria')}
        aria-invalid={!!error}
      />
      {isStreaming && (
        <Loader2
          size={11}
          className="text-fg-subtle shrink-0 animate-spin"
          aria-label={t('search.searching')}
        />
      )}
      {showCount && (
        <span className="text-fg-subtle shrink-0 text-xs font-normal tabular-nums">
          {results.length}
        </span>
      )}
      {query.length === 0 && (
        <kbd className="bg-bg-default text-fg-subtle inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-xs font-normal">
          {isMac
            ? searchShortcutTokens.map((token, index) => (
                <span key={`${index}-${token}`}>{token}</span>
              ))
            : formatShortcutById('search.open')}
        </kbd>
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
