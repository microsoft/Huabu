import { HelpCircle } from 'lucide-react';
import React from 'react';
import { Link } from 'react-router-dom';

import { CanvasMenu } from './CanvasMenu';
import { SettingsPopover } from './SettingsPopover';
import { IconButton } from '../Common/IconButton';

interface HeaderProps {
  children?: React.ReactNode;
  onOpenHelp?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ children, onOpenHelp }) => {
  return (
    <header className="border-border bg-surface flex h-12 items-center gap-3 border-b px-3">
      <Link to="/" aria-label="Back to home">
        <img src="/favicon.svg" alt="Logo" className="h-8 w-8" />
      </Link>

      {children ?? <CanvasMenu />}

      <div className="flex-1" />

      {onOpenHelp && (
        <IconButton
          variant="outline"
          title="Keyboard Shortcuts (?)"
          onClick={onOpenHelp}
          aria-label="Keyboard shortcuts"
        >
          <HelpCircle size={18} />
        </IconButton>
      )}

      <SettingsPopover />
    </header>
  );
};
