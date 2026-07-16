// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Search as SearchIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { withBasePath } from '../basePath';
import { Kbd } from './Code';
import { Shortcut } from './Shortcut';

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export function Search() {
  const id = useId().replace(/:/g, '');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const hasBeenOpen = useRef(false);
  const isInitializing = useRef(false);
  const isReady = useRef(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const focusSearchInput = useCallback(() => {
    document
      .querySelector<HTMLInputElement>(`#${id} .pagefind-ui__search-input`)
      ?.focus();
  }, [id]);

  const initialize = useCallback(async () => {
    if (import.meta.env.DEV || isInitializing.current) return;
    if (isReady.current) {
      focusSearchInput();
      return;
    }
    isInitializing.current = true;
    try {
      const { PagefindUI } = await import('@pagefind/default-ui');
      new PagefindUI({
        element: `#${id}`,
        bundlePath: withBasePath('pagefind/'),
        baseUrl: withBasePath(''),
        showSubResults: true,
        pageSize: 10,
      });
      isReady.current = true;
      focusSearchInput();
    } catch {
      setError('Search could not be loaded. Please try again.');
    } finally {
      isInitializing.current = false;
    }
  }, [focusSearchInput, id]);

  const openSearch = useCallback(() => {
    setHasOpened(true);
    setIsOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setIsOpen(false);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    hasBeenOpen.current = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    void initialize();

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [initialize, isOpen]);

  useEffect(() => {
    if (isOpen || !hasBeenOpen.current) return;
    triggerRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      } else if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        closeSearch();
      }
    };

    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, [closeSearch, isOpen, openSearch]);

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hidden);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openSearch}
        className="mb-2 flex w-full items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-left text-sm text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
      >
        <SearchIcon className="h-4 w-4" />
        <span className="flex-1">Search</span>
        <Shortcut combo="mod+k" />
      </button>
      {hasOpened &&
        createPortal(
          <div
            className={
              isOpen
                ? 'fixed inset-0 z-[100] flex items-start justify-center bg-black/45 px-4 pt-[10vh] backdrop-blur-[2px]'
                : 'hidden'
            }
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeSearch();
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${id}-title`}
              className="docs-search-modal relative flex max-h-[78vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
              onKeyDown={trapFocus}
            >
              <h2 id={`${id}-title`} className="sr-only">
                Search
              </h2>
              <div className="min-h-0 overflow-x-hidden overflow-y-auto p-3 sm:p-4">
                {import.meta.env.DEV ? (
                  <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-gray-200 px-6 text-center text-sm text-gray-500">
                    Search is available in a built preview.
                  </div>
                ) : error ? (
                  <div className="flex min-h-32 items-center justify-center px-6 text-center text-sm text-red-600">
                    {error}
                  </div>
                ) : (
                  <div id={id} />
                )}
              </div>
              <div className="flex items-center justify-end border-t border-gray-100 bg-gray-50 px-4 py-1.5 text-xs text-gray-500">
                <button
                  ref={closeRef}
                  type="button"
                  onClick={closeSearch}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 leading-none transition-colors hover:bg-gray-200 hover:text-gray-900"
                >
                  <Kbd>Esc</Kbd>
                  Close
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
