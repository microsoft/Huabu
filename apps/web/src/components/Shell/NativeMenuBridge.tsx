// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { APP_NAME } from '../../config/app';
import { openUserHandbook } from '../../config/handbook';
import { canCheckForUpdates, useAppUpdate } from '../../hooks/useAppUpdate';
import { useCanvasActions } from '../../hooks/useCanvasActions';
import {
  copySystemInfo,
  getElectronBridge,
  openDeveloperTools,
  openServerLog,
} from '../../hooks/useElectron';
import { useRunDiagnostic } from '../../hooks/useRunDiagnostic';
import { useSettingsUiStore } from '../../store/settingsUiStore';
import { useShortcutsUiStore } from '../../store/shortcutsUiStore';
import { useWorkspaceStore } from '../../store/workspaceStore';

/**
 * Bridges the native macOS menu bar to the in-app action handlers.
 *
 * On macOS the workspace-level actions (New Canvas, Import, Switch
 * Workspace, Settings, User Handbook, Keyboard Shortcuts) live in the OS
 * menu bar — the platform-conventional home for them — instead of the
 * logo dropdown crammed next to the traffic-lights. The menu itself is
 * built in the Electron main process; this component:
 *
 *   1. pushes the current i18n labels + `canChangeWorkspace` flag so the
 *      native menu matches the in-app language (re-pushed on language /
 *      capability change), and
 *   2. maps menu-item activations back onto the exact same handlers the
 *      in-app `AppMenu` dropdown uses, so behaviour has a single source
 *      of truth.
 *
 * Renders nothing on Windows / Linux / the browser (there is no native
 * menu bar there). On macOS it also renders the hidden `<input>` the
 * import command clicks, because the title-bar `AppMenu` (which normally
 * hosts that input) is hidden on macOS.
 */
export function NativeMenuBridge() {
  const bridge = getElectronBridge();
  const menu = bridge?.menu;
  const isMac = bridge?.platform === 'darwin';
  const enabled = isMac && !!menu;

  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const canChangeWorkspace = useWorkspaceStore(
    (s) => s.capabilities?.canChangeWorkspace ?? true,
  );
  const { create, openImportDialog, fileInputRef, onFileChange } =
    useCanvasActions();
  const openSettings = useSettingsUiStore((s) => s.open);
  const openShortcuts = useShortcutsUiStore((s) => s.open);
  const runDiagnostic = useRunDiagnostic();
  const { status: updateStatus, check: checkForUpdates } = useAppUpdate();
  const updateCheckEnabled = canCheckForUpdates(updateStatus);

  // Push localized labels + capability flags to the native menu. Re-runs
  // when the interface language or the workspace capability changes so
  // the menu bar stays in sync with the rest of the UI.
  useEffect(() => {
    if (!enabled) return;
    menu.configure({
      labels: {
        file: t('menu.file'),
        edit: t('menu.edit'),
        view: t('menu.view'),
        window: t('menu.window'),
        help: t('menu.help'),
        about: t('menu.about', { app: APP_NAME }),
        services: t('menu.services'),
        hide: t('menu.hide', { app: APP_NAME }),
        hideOthers: t('menu.hideOthers'),
        unhide: t('menu.unhide'),
        quit: t('menu.quit', { app: APP_NAME }),
        undo: t('menu.undo'),
        redo: t('menu.redo'),
        cut: t('menu.cut'),
        copy: t('menu.copy'),
        paste: t('menu.paste'),
        pasteAndMatchStyle: t('menu.pasteAndMatchStyle'),
        selectAll: t('menu.selectAll'),
        minimize: t('menu.minimize'),
        zoom: t('menu.zoom'),
        front: t('menu.front'),
        close: t('menu.close'),
        toggleFullScreen: t('menu.toggleFullScreen'),
        newCanvas: t('actions.newCanvas'),
        import: t('actions.importCanvas'),
        switchWorkspace: t('navigation.switchWorkspace'),
        settings: t('settings.title'),
        checkForUpdates: t('update.check'),
        userHandbook: t('navigation.userHandbook'),
        keyboardShortcuts: t('shortcuts.title'),
        troubleshooting: t('troubleshooting.title'),
        openServerLog: t('troubleshooting.openServerLog'),
        openDeveloperTools: t('troubleshooting.openDeveloperTools'),
        copySystemInfo: t('troubleshooting.copySystemInfo'),
      },
      canChangeWorkspace,
      canCheckForUpdates: updateCheckEnabled,
    });
    // `i18n.language` is an explicit dependency so a language switch
    // re-pushes labels even though `t` is a stable reference.
  }, [enabled, menu, t, i18n.language, canChangeWorkspace, updateCheckEnabled]);

  // Dispatch native menu commands to the matching in-app handler.
  useEffect(() => {
    if (!enabled) return;
    return menu.onCommand((command) => {
      switch (command) {
        case 'new-canvas':
          void create();
          break;
        case 'import-canvas':
          openImportDialog();
          break;
        case 'switch-workspace':
          navigate('/setup');
          break;
        case 'open-settings':
          openSettings();
          break;
        case 'check-for-updates':
          checkForUpdates();
          break;
        case 'open-handbook':
          openUserHandbook();
          break;
        case 'open-shortcuts':
          openShortcuts();
          break;
        case 'open-server-log':
          runDiagnostic(openServerLog);
          break;
        case 'open-developer-tools':
          runDiagnostic(openDeveloperTools);
          break;
        case 'copy-system-info':
          runDiagnostic(copySystemInfo, t('troubleshooting.systemInfoCopied'));
          break;
        default:
          break;
      }
    });
  }, [
    enabled,
    menu,
    create,
    openImportDialog,
    navigate,
    openSettings,
    checkForUpdates,
    openShortcuts,
    runDiagnostic,
    t,
  ]);

  if (!enabled) return null;

  return (
    <input
      ref={fileInputRef}
      type="file"
      accept=".zip,application/zip"
      className="hidden"
      onChange={(e) => void onFileChange(e)}
    />
  );
}
