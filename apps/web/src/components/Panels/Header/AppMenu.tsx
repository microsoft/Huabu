// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { openUserHandbook } from '../../../config/handbook';
import { getShortcutKeys } from '../../../config/shortcuts';
import { canCheckForUpdates, useAppUpdate } from '../../../hooks/useAppUpdate';
import { useCanvasActions } from '../../../hooks/useCanvasActions';
import {
  copySystemInfo,
  desktopDiagnosticsAvailable,
  getElectronBridge,
  isElectron,
  openDeveloperTools,
  openServerLog,
} from '../../../hooks/useElectron';
import { useRunDiagnostic } from '../../../hooks/useRunDiagnostic';
import { useSettingsUiStore } from '../../../store/settingsUiStore';
import { useShortcutsUiStore } from '../../../store/shortcutsUiStore';
import { useWorkspaceStore } from '../../../store/workspaceStore';
import { formatShortcut } from '../../../utils/platform';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSubmenu,
} from '../../Common/DropdownMenu';

interface AppMenuProps {
  /**
   * Size of the logo trigger. `compact` (`h-6 w-6`) suits the in-canvas
   * header; the default (`h-8 w-8`) matches the standalone list header.
   */
  compact?: boolean;
  /**
   * Override the img classes entirely (e.g. the Electron title bar uses a
   * 28px hit area to line up with the caption buttons).
   */
  logoClassName?: string;
}

/**
 * Application menu — the logo doubles as a trigger for a dropdown of
 * workspace-level actions (new / import canvas, switch workspace,
 * settings, handbook, keyboard shortcuts).
 *
 * This replaces the old "logo is a plain link to /" affordance. Every
 * action reuses an existing handler (the `useCanvasActions` hook, the
 * `settingsUi` / `shortcutsUi` stores, the docs window) rather than
 * duplicating logic, so the menu and the standalone buttons stay in sync.
 */
export const AppMenu: React.FC<AppMenuProps> = ({
  compact = false,
  logoClassName,
}) => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const showCanvasListLink = location.pathname !== '/spaces';

  const canChangeWorkspace = useWorkspaceStore(
    (s) => s.capabilities?.canChangeWorkspace ?? true,
  );
  const worldCanvasId = useWorkspaceStore((s) => s.worldCanvasId);
  const worldEnabled = useWorkspaceStore((s) => s.worldEnabled);
  const onWorld =
    worldCanvasId !== null && location.pathname === `/canvas/${worldCanvasId}`;
  const { create, openImportDialog, fileInputRef, onFileChange } =
    useCanvasActions();
  const openSettings = useSettingsUiStore((s) => s.open);
  const openShortcuts = useShortcutsUiStore((s) => s.open);
  const diagnosticsAvailable = desktopDiagnosticsAvailable();
  const runDiagnostic = useRunDiagnostic();
  const { status: updateStatus, check: checkForUpdates } = useAppUpdate();
  const updaterAvailable = !!getElectronBridge()?.updater;

  const runAndClose = (fn: () => void) => () => {
    setIsOpen(false);
    fn();
  };

  // New Canvas / Settings only fire via a global hotkey inside Electron
  // (macOS routes them through the native menu; browsers reserve Cmd+N).
  // Show those hints only where they actually work; the `?` help hotkey
  // is global on every platform, so it always shows.
  const appHintsVisible = isElectron();
  const newCanvasKeys = getShortcutKeys('app.newCanvas');
  const settingsKeys = getShortcutKeys('app.openSettings');
  const shortcutsKeys = getShortcutKeys('help.show');
  const newCanvasHint =
    appHintsVisible && newCanvasKeys
      ? formatShortcut(newCanvasKeys)
      : undefined;
  const settingsHint =
    appHintsVisible && settingsKeys ? formatShortcut(settingsKeys) : undefined;
  const shortcutsHint = shortcutsKeys
    ? formatShortcut(shortcutsKeys)
    : undefined;

  return (
    <>
      {/* Hidden file input for import — clicked via the hook's
          `openImportDialog`. */}
      <input
        ref={fileInputRef}
        type="file"
        name="space-import-archive"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => void onFileChange(e)}
      />

      <DropdownMenu
        open={isOpen}
        onOpenChange={setIsOpen}
        trigger={
          <button
            type="button"
            aria-label={t('navigation.appMenu')}
            className="hover:bg-hover flex shrink-0 items-center justify-center rounded-md p-0.5 transition-colors"
          >
            <img
              src="/favicon.svg"
              alt={t('app.logoAlt')}
              className={logoClassName ?? (compact ? 'h-6 w-6' : 'h-8 w-8')}
            />
          </button>
        }
      >
        {worldEnabled && worldCanvasId && !onWorld && (
          <DropdownMenuItem
            onClick={runAndClose(() => navigate(`/canvas/${worldCanvasId}`))}
          >
            {t('world.openWorld')}
          </DropdownMenuItem>
        )}
        {showCanvasListLink && (
          <>
            <DropdownMenuItem onClick={runAndClose(() => navigate('/spaces'))}>
              {t('canvasPage.backToList')}
            </DropdownMenuItem>
            <div className="border-edge-default my-1 border-t" />
          </>
        )}

        <DropdownMenuItem
          shortcut={newCanvasHint}
          onClick={runAndClose(() => void create())}
        >
          {t('actions.newCanvas')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={runAndClose(openImportDialog)}>
          {t('actions.importCanvas')}
        </DropdownMenuItem>

        {canChangeWorkspace && (
          <DropdownMenuItem onClick={runAndClose(() => navigate('/setup'))}>
            {t('navigation.switchWorkspace')}
          </DropdownMenuItem>
        )}

        <div className="border-edge-default my-1 border-t" />
        <DropdownMenuItem
          shortcut={settingsHint}
          onClick={runAndClose(openSettings)}
        >
          {t('settings.title')}
        </DropdownMenuItem>
        <DropdownMenuItem
          shortcut={shortcutsHint}
          onClick={runAndClose(openShortcuts)}
        >
          {t('shortcuts.title')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={runAndClose(openUserHandbook)}>
          {t('navigation.userHandbook')}
        </DropdownMenuItem>

        {updaterAvailable && (
          <DropdownMenuItem
            disabled={!canCheckForUpdates(updateStatus)}
            onClick={runAndClose(checkForUpdates)}
          >
            {updateStatus.state === 'checking'
              ? t('update.checking')
              : t('update.check')}
          </DropdownMenuItem>
        )}

        {diagnosticsAvailable && (
          <DropdownMenuSubmenu label={t('troubleshooting.title')}>
            <DropdownMenuItem
              onClick={runAndClose(() => runDiagnostic(openServerLog))}
            >
              {t('troubleshooting.openServerLog')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={runAndClose(() => runDiagnostic(openDeveloperTools))}
            >
              {t('troubleshooting.openDeveloperTools')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={runAndClose(() =>
                runDiagnostic(
                  copySystemInfo,
                  t('troubleshooting.systemInfoCopied'),
                ),
              )}
            >
              {t('troubleshooting.copySystemInfo')}
            </DropdownMenuItem>
          </DropdownMenuSubmenu>
        )}
      </DropdownMenu>
    </>
  );
};
