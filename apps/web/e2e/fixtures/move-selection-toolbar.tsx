// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ReactFlow } from '@xyflow/react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { NodeFloatingToolbar } from '@/components/Panels/Canvas/FloatingToolbars/NodeFloatingToolbar';
import { MoveSelectionPopover } from '@/components/Panels/Canvas/MoveSelectionPopover';
import { i18n } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';

import '@xyflow/react/dist/style.css';

const data = { type: 'note' as const, content: 'Selected note' };
const nodeTypes = { note: () => <div>Selected note</div> };

function SelectionCanvas() {
  const nodes = useCanvasStore((state) => state.nodes);
  const selectNodes = useCanvasStore((state) => state.selectNodes);
  return (
    <ReactFlow
      nodes={nodes}
      edges={[]}
      nodeTypes={nodeTypes}
      onPaneClick={() => selectNodes([])}
    >
      {nodes.some((node) => node.selected) && (
        <NodeFloatingToolbar
          id="move-anchor-node"
          type="note"
          data={data}
          dragEnabled={false}
        />
      )}
      <MoveSelectionPopover />
    </ReactFlow>
  );
}

export async function mountMoveSelectionToolbar() {
  await i18n.changeLanguage('en');
  const nodes = [
    {
      id: 'move-anchor-node',
      type: 'note',
      selected: true,
      position: { x: 400, y: 300 },
      style: { width: 320, height: 200 },
      data,
    },
  ];
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;inset:0;background:var(--bg-default);z-index:900';
  document.body.append(host);
  // This fixture never submits or persists content; it exercises real toolbar positioning.
  useCanvasStore.setState({
    canvasId: 'move-anchor-source',
    canvasWrapper: host,
    nodes,
    edges: [],
    moveSelectionDialogOpen: false,
    moveSelectionAnchor: null,
  });
  createRoot(host).render(
    <MemoryRouter>
      <SelectionCanvas />
    </MemoryRouter>,
  );
}
