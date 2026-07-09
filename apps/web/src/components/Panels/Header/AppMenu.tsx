import {
  BookOpen,
  FolderOpen,
  Keyboard,
  Plus,
  Settings,
  Upload,
} from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useCanvasActions } from '../../../hooks/useCanvasActions';
import { useSettingsUiStore } from '../../../store/settingsUiStore';
import { useShortcutsUiStore } from '../../../store/shortcutsUiStore';
import { useWorkspaceStore } from '../../../store/workspaceStore';
import { DropdownMenu, DropdownMenuItem } from '../../Common/DropdownMenu';

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
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);

  const canChangeWorkspace = useWorkspaceStore(
    (s) => s.capabilities?.canChangeWorkspace ?? true,
  );
  const { create, openImportDialog, fileInputRef, onFileChange } =
    useCanvasActions();
  const openSettings = useSettingsUiStore((s) => s.open);
  const openShortcuts = useShortcutsUiStore((s) => s.open);

  const runAndClose = (fn: () => void) => () => {
    setIsOpen(false);
    fn();
  };

  return (
    <>
      {/* Hidden file input for import — clicked via the hook's
          `openImportDialog`. */}
      <input
        ref={fileInputRef}
        type="file"
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
        <DropdownMenuItem
          icon={<Plus size={14} />}
          onClick={runAndClose(() => void create())}
        >
          {t('actions.newCanvas')}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Upload size={14} />}
          onClick={runAndClose(openImportDialog)}
        >
          {t('actions.import')}
        </DropdownMenuItem>

        {canChangeWorkspace && (
          <>
            <div className="border-edge-default my-1 border-t" />
            <DropdownMenuItem
              icon={<FolderOpen size={14} />}
              onClick={runAndClose(() => navigate('/setup'))}
            >
              {t('navigation.switchWorkspace')}
            </DropdownMenuItem>
          </>
        )}

        <div className="border-edge-default my-1 border-t" />
        <DropdownMenuItem
          icon={<Settings size={14} />}
          onClick={runAndClose(openSettings)}
        >
          {t('settings.title')}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<BookOpen size={14} />}
          onClick={runAndClose(() =>
            window.open('/docs', '_blank', 'noopener'),
          )}
        >
          {t('navigation.userHandbook')}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Keyboard size={14} />}
          shortcut="?"
          onClick={runAndClose(openShortcuts)}
        >
          {t('shortcuts.title')}
        </DropdownMenuItem>
      </DropdownMenu>
    </>
  );
};
