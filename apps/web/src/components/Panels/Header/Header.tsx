import { HelpCircle } from 'lucide-react';
import React from 'react';
import { Link } from 'react-router-dom';

import { CanvasMenu } from './CanvasMenu.tsx';
import { SettingsPopover } from './SettingsPopover';
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
  // In Electron the custom title bar (`WindowChrome`) already provides a
  // Home button and the global settings popover, so we hide the duplicates
  // here to keep the inner header focused on the canvas menu.
  const isElectronApp = isElectron();

  return (
    <header className="border-edge-default bg-surface flex h-12 items-center gap-3 border-b px-3">
      {!isElectronApp && (
        <Link to="/" aria-label="Back to home">
          <img src="/favicon.svg" alt="Logo" className="h-6 w-6" />
        </Link>
      )}

      {children ?? <CanvasMenu />}

      <div className="flex-1" />

      {onOpenHelp && (
        <Button
          variant="outline"
          shape="pill"
          iconOnly
          title="Keyboard Shortcuts (?)"
          onClick={onOpenHelp}
          aria-label="Keyboard shortcuts"
        >
          <HelpCircle />
        </Button>
      )}

      {!isElectronApp && <SettingsPopover />}
    </header>
  );
};
