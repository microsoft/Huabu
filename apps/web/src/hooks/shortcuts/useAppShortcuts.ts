// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect } from 'react';

import { isEditableTarget } from './isEditableTarget';
import { getCombo, matches } from '../../config/shortcuts';
import { useSettingsUiStore } from '../../store/settingsUiStore';
import { useCanvasActions } from '../useCanvasActions';
import { getElectronBridge } from '../useElectron';

/**
 * Global app-level hotkeys — New Canvas (Ctrl/Cmd+N) and Settings
 * (Ctrl/Cmd+,) — the two shortcuts the `AppMenu` dropdown advertises.
 *
 * Platform ownership (so a keystroke never fires twice):
 *   - macOS: the native menu bar (see `NativeMenuBridge`) registers both
 *     accelerators itself, so this hook skips them there.
 *   - Windows / Linux: there is no native menu, so this hook is what makes
 *     the accelerators work; the dropdown shows the matching hint.
 *   - New Canvas is Electron-only: browsers reserve Cmd/Ctrl+N for a new
 *     window and won't yield it to the page, so we don't claim it there.
 *
 * Mount exactly once at the router root (`GlobalModals`), next to the
 * `?` hotkey. Skipped while focus is in an editable target so the keys
 * stay usable while typing.
 */
export function useAppShortcuts(): void {
  const { create } = useCanvasActions();
  const openSettings = useSettingsUiStore((s) => s.open);

  useEffect(() => {
    const newCanvasCombo = getCombo('app.newCanvas');
    const settingsCombo = getCombo('app.openSettings');

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (isEditableTarget(e.target)) return;

      const bridge = getElectronBridge();
      const isMacElectron = bridge?.platform === 'darwin';

      // Settings — Ctrl/Cmd+,. Skipped on macOS (native menu owns it).
      if (settingsCombo && matches(e, settingsCombo)) {
        if (isMacElectron) return;
        e.preventDefault();
        openSettings();
        return;
      }

      // New Canvas — Ctrl/Cmd+N. Native menu owns it on macOS; browsers
      // reserve it for a new window, so only wire it inside Electron.
      if (newCanvasCombo && matches(e, newCanvasCombo)) {
        if (isMacElectron || !bridge) return;
        e.preventDefault();
        void create();
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [create, openSettings]);
}
