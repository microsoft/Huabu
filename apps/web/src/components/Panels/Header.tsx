import React from 'react';
import { Link } from 'react-router-dom';

import { SettingsPopover } from './SettingsPopover';
import { WorkspaceMenu } from './WorkspaceMenu';

interface HeaderProps {
  children?: React.ReactNode;
}

export const Header: React.FC<HeaderProps> = ({ children }) => {
  return (
    <header className="border-border flex h-12 items-center gap-3 border-b bg-white px-3">
      <Link to="/" aria-label="Back to home">
        <img src="/favicon.svg" alt="Logo" className="h-8 w-8" />
      </Link>

      {children ?? <WorkspaceMenu />}

      <div className="flex-1" />

      <SettingsPopover />
    </header>
  );
};
