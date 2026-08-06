// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { HelpCircle } from 'lucide-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsPopover } from '@/components/Settings/SettingsPopover';

import { AppMenu } from './AppMenu';
import { CanvasMenu } from './CanvasMenu.tsx';
import { isElectron } from '../../../hooks/useElectron';
import { Button } from '../../Common/Button';

interface HeaderProps {
  children?: React.ReactNode;
  onOpenHelp?: () => void;
}

/**
 * Standalone-page header used on the canvas list and component showcase.
 * The in-canvas header lives in `CanvasHeader.tsx` and has its own
 * collapsed / floating logic.
 */
export const Header: React.FC<HeaderProps> = ({ children, onOpenHelp }) => {
  const { t } = useTranslation();
  // In Electron the custom title bar (`WindowChrome`) already provides a
  // Home button and the global settings popover, so we hide the duplicates
  // here to keep the inner header focused on the canvas menu.
  const isElectronApp = isElectron();

  return (
    <header className="border-edge-default bg-surface flex h-12 items-center gap-3 border-b px-3">
      {!isElectronApp && <AppMenu compact />}

      {children ?? <CanvasMenu />}

      <div className="flex-1" />

      {onOpenHelp && (
        <Button
          variant="outline"
          shape="pill"
          iconOnly
          title={`${t('shortcuts.title')} (?)`}
          onClick={onOpenHelp}
          aria-label={t('shortcuts.title')}
        >
          <HelpCircle />
        </Button>
      )}

      {!isElectronApp && <SettingsPopover />}
    </header>
  );
};
