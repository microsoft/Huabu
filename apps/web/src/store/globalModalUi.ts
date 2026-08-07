// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useSettingsUiStore } from './settingsUiStore';
import { useShortcutsUiStore } from './shortcutsUiStore';

/**
 * Aggregated open-state for every app-wide modal.
 *
 * Each modal owns its own open-flag store (`settingsUiStore`,
 * `shortcutsUiStore`, ...) — that stays deliberately decoupled. This
 * hook is the single place that knows *which* of those stores count as
 * a full-window modal, so consumers can ask one question ("is any
 * global modal open?") instead of enumerating every store. Add new
 * app-wide modals here rather than at each call site.
 *
 * Used e.g. by `CanvasFloatingPopover` to suppress canvas floating
 * toolbars while a modal backdrop covers the window.
 */
export function useAnyGlobalModalOpen(): boolean {
  const settingsOpen = useSettingsUiStore((s) => s.isOpen);
  const shortcutsOpen = useShortcutsUiStore((s) => s.isOpen);
  return settingsOpen || shortcutsOpen;
}
