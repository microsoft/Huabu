// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect } from 'react';

import { isEditableTarget } from './isEditableTarget';
import { useShortcutsUiStore } from '../../store/shortcutsUiStore';

/**
 * Registers the global `?` hotkey that toggles the Keyboard Shortcuts
 * help modal. The modal's open-state now lives in
 * {@link useShortcutsUiStore} so it can be reached from any page chrome
 * (canvas menu, title-bar `AppMenu`, canvas list) — not just from inside
 * a canvas.
 *
 * Mount this exactly once (at the router root): a second mount would
 * register a second capture listener and the two toggles would cancel
 * each other out.
 *
 * Handles `?` / `？` (half-width or full-width). Skipped when focus is
 * inside an input / textarea / contentEditable target so typing a
 * literal question mark doesn't pop the modal.
 */
export function useShortcutsHelpHotkey(): void {
  const toggle = useShortcutsUiStore((s) => s.toggle);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== '?' && e.key !== '？') return;
      if (isEditableTarget(e.target)) return;

      e.preventDefault();
      toggle();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [toggle]);
}
