import React from 'react';

import type { Doc } from '@blocksuite/store';

interface EditorProps {
  doc: Doc;
}

export const BlockSuiteEditor: React.FC<EditorProps> = () => {
  return (
    <div className="relative flex h-full w-full flex-col bg-gray-100"></div>
  );
};
