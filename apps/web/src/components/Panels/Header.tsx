import React from 'react';

import { SettingsPopover } from './SettingsPopover';
import { WorkspaceMenu } from './WorkspaceMenu';

export const Header: React.FC = () => {
  return (
    <header className="border-border flex h-12 items-center gap-3 border-b bg-white px-3">
      <img src="/favicon.svg" alt="Logo" className="h-8 w-8" />

      <WorkspaceMenu />

      <div className="flex-1" />

      <SettingsPopover />
    </header>
  );
};
