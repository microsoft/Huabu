// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Check, Folder, FolderOpen } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import {
  getElectronBridge,
  requireDesktopTabSuccess,
} from '../../hooks/useElectron';
import {
  useWorkspaceLabel,
  useWorkspaceStore,
} from '../../store/workspaceStore';
import { cn } from '../Common/cn';
import { DropdownMenuItem, DropdownMenuLink } from '../Common/DropdownMenu';
import {
  MENU_CHECK_CLASS,
  MENU_SECTION_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SURFACE_CLASS,
} from '../Common/menuStyles';
import { Popover } from '../Common/Popover';
import { toast } from '../Common/Toast';

import type { DesktopHomeMenuPosition } from '@huabu/shared/desktop-tabs';

export function DesktopHomeMenu() {
  const tabs = getElectronBridge()?.tabs;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const label = useWorkspaceLabel();
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const recent = useWorkspaceStore((s) => s.recentWorkspaces);
  const canChange = useWorkspaceStore(
    (s) => s.capabilities?.canChangeWorkspace ?? true,
  );
  const syncing = useWorkspaceStore((s) => s.isSyncing);
  const activate = useWorkspaceStore((s) => s.activateRecentWorkspace);
  const [position, setPosition] = useState<DesktopHomeMenuPosition | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => tabs?.onHomeMenu(setPosition), [tabs]);

  const close = (restoreFocus = true) => {
    setPosition(null);
    void tabs
      ?.command(restoreFocus ? 'close-home-menu' : 'dismiss-home-menu')
      .then(requireDesktopTabSuccess)
      .catch((error: unknown) => {
        console.error(
          '[desktop-home-menu] Could not dismiss Home menu:',
          error,
        );
        toast(error instanceof Error ? error.message : String(error), {
          tone: 'danger',
        });
      });
  };
  const reportError = (error: unknown) => {
    console.error('[workspace-switcher] Could not open Workspace:', error);
    toast(useWorkspaceStore.getState().error ?? t('workspace.switchFailed'), {
      tone: 'danger',
    });
  };
  const switchWorkspace = async (id: string) => {
    close();
    if (id === workspaceId) {
      navigate('/spaces');
      return;
    }
    setBusy(true);
    try {
      await activate(id);
      navigate('/spaces');
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    const current = items.findIndex((item) => item === document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };

  if (!position) return null;
  const workspaces =
    workspaceId &&
    label &&
    !recent.some((workspace) => workspace.workspaceId === workspaceId)
      ? [
          { workspaceId, name: label, path: workspacePath, active: true },
          ...recent,
        ]
      : recent;

  return (
    <Popover
      position={{ x: position.x, y: 4 }}
      anchor="top-left"
      onDismiss={(reason) => close(reason === 'escape')}
      className={cn(MENU_SURFACE_CLASS, 'w-80 max-w-[calc(100vw-2rem)]')}
      onOpenAutoFocus={() => {
        const items = menu.current?.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not(:disabled)',
        );
        (items?.[0] ?? menu.current)?.focus();
      }}
    >
      <div
        ref={menu}
        role="menu"
        tabIndex={-1}
        aria-label={t('workspace.switcher')}
        onKeyDown={onMenuKeyDown}
      >
        <div className={MENU_SECTION_LABEL_CLASS}>{t('workspace.recent')}</div>
        <div className="max-h-72 overflow-y-auto overscroll-contain">
          {workspaces.map((workspace) => (
            <DropdownMenuItem
              key={workspace.workspaceId}
              disabled={!canChange || busy || syncing}
              aria-current={
                workspace.workspaceId === workspaceId ? 'true' : undefined
              }
              icon={<Folder aria-hidden />}
              trailing={
                workspace.workspaceId === workspaceId ? (
                  <span className={MENU_CHECK_CLASS}>
                    <Check aria-hidden />
                  </span>
                ) : undefined
              }
              onClick={() => void switchWorkspace(workspace.workspaceId)}
            >
              <span className="text-fg-default block truncate">
                {workspace.name}
              </span>
              {workspace.path ? (
                <span className="text-fg-subtle block truncate text-xs">
                  {workspace.path}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </div>
        {canChange && <div role="separator" className={MENU_SEPARATOR_CLASS} />}
        {canChange && (
          <DropdownMenuLink
            to="/setup"
            icon={<FolderOpen aria-hidden />}
            onClick={() => close()}
          >
            {t('workspace.open')}
          </DropdownMenuLink>
        )}
      </div>
    </Popover>
  );
}
