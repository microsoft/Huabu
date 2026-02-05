import React from 'react';

export const Header: React.FC = () => {
  return (
    <header className="border-border flex h-12 items-center gap-3 border-b bg-white px-3">
      <img src="/favicon.svg" alt="Logo" className="h-8 w-8" />
      <div className="text-main m-0 text-lg font-medium">
        Sediment Workspace Name
      </div>
    </header>
  );
};
