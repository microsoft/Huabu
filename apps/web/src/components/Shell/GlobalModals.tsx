// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useAppShortcuts, useShortcutsHelpHotkey } from '../../hooks/shortcuts';
import { useSettingsUiStore } from '../../store/settingsUiStore';
import { useShortcutsUiStore } from '../../store/shortcutsUiStore';
import { KeyboardShortcutsModal } from '../Panels/Header/KeyboardShortcutsModal';
import { SettingsModal } from '../Settings/SettingsModal';

/**
 * Mounts the app-wide singleton modals (Settings + Keyboard Shortcuts)
 * and registers the global `?` hotkey.
 *
 * Rendered once from the never-unmounting router root (`RootLayout`) so
 * every surface — the title-bar gear, the floating canvas gear, the
 * `AppMenu`, the canvas menu — drives the *same* modal instance via the
 * `settingsUi` / `shortcutsUi` stores instead of each owning its own
 * copy. This is also what makes the shortcuts help reachable from the
 * canvas list page, not just from inside a canvas.
 */
export function GlobalModals() {
  const settingsOpen = useSettingsUiStore((s) => s.isOpen);
  const closeSettings = useSettingsUiStore((s) => s.close);
  const shortcutsOpen = useShortcutsUiStore((s) => s.isOpen);
  const closeShortcuts = useShortcutsUiStore((s) => s.close);

  useShortcutsHelpHotkey();
  useAppShortcuts();

  return (
    <>
      <SettingsModal isOpen={settingsOpen} onClose={closeSettings} />
      <KeyboardShortcutsModal isOpen={shortcutsOpen} onClose={closeShortcuts} />
    </>
  );
}
