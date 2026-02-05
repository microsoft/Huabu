import React from 'react';

export const Header: React.FC = () => {
  return (
    <header className="shadow-bottom flex h-16 items-center gap-3 bg-white px-4">
      <img src="/favicon.svg" alt="Logo" className="h-12 w-12" />
      <h2 className="m-0 text-lg font-semibold text-gray-900">Sediment</h2>
    </header>
  );
};
