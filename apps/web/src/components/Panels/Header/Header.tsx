import { HelpCircle } from 'lucide-react';
import React from 'react';
import { Link } from 'react-router-dom';

import { CanvasMenu } from './CanvasMenu.tsx';
import { SettingsPopover } from './SettingsPopover';
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
  return (
    <header className="border-edge-default bg-surface flex h-12 items-center gap-3 border-b px-3">
      <Link to="/" aria-label="Back to home">
        <img src="/favicon.svg" alt="Logo" className="h-6 w-6" />
      </Link>

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

      <SettingsPopover />
    </header>
  );
};
