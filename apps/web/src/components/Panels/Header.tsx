import React from 'react';

import useCanvasStore from '../../store/canvasStore';

export const Header: React.FC = () => {
  const workspaceName = useCanvasStore((s) => s.workspaceName);
  const setWorkspaceName = useCanvasStore((s) => s.setWorkspaceName);

  return (
    <header className="border-border flex h-12 items-center gap-3 border-b bg-white px-3">
      <img src="/favicon.svg" alt="Logo" className="h-8 w-8" />
      <input
        className="text-main focus:shadow-bottom m-0 max-w-72 min-w-0 flex-1 bg-transparent px-2 py-1 text-lg font-medium outline-none focus:rounded-md"
        value={workspaceName}
        onChange={(e) => setWorkspaceName(e.target.value)}
        aria-label="Workspace name"
      />
    </header>
  );
};
