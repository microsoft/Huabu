import { useCallback, useEffect, useState } from 'react';

import { isEditableTarget } from './isEditableTarget';

export interface UsePageShortcutsResult {
  /** Whether the Keyboard Shortcuts modal should be open. */
  isShortcutsOpen: boolean;
  openShortcuts: () => void;
  closeShortcuts: () => void;
}

/**
 * Page-level (window-scoped) keyboard shortcut handler.
 *
 * Unlike `useCanvasShortcuts` — which lives inside the canvas widget and
 * is tied to ReactFlow / store actions — this hook handles shortcuts that
 * conceptually belong to the **page chrome**: open the Keyboard Shortcuts
 * help modal, etc. It owns the open-state for the help modal so callers
 * don't have to wire `useState` + `useEffect` boilerplate themselves.
 *
 * Currently handles:
 *  - `?` / `？` (half-width or full-width) → toggle the help modal.
 *    Skipped when focus is inside an input / textarea / contentEditable
 *    target so typing a literal question mark doesn't pop the modal.
 *
 * The hook is intentionally page-agnostic — any top-level page that wants
 * to surface the Keyboard Shortcuts modal can call it and render
 * `<KeyboardShortcutsModal isOpen={…} onClose={…} />` against the
 * returned state.
 */
export function usePageShortcuts(): UsePageShortcutsResult {
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);

  const openShortcuts = useCallback(() => setIsShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setIsShortcutsOpen(false), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== '?' && e.key !== '？') return;
      if (isEditableTarget(e.target)) return;

      e.preventDefault();
      setIsShortcutsOpen((prev) => !prev);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return { isShortcutsOpen, openShortcuts, closeShortcuts };
}
