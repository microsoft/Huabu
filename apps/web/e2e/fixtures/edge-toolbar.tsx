// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ReactFlow } from '@xyflow/react';
import { createRoot } from 'react-dom/client';

import { EdgeStyleToolbar } from '@/components/Panels/Canvas/FloatingToolbars/EdgeStyleToolbar';
import { i18n } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';

import '@xyflow/react/dist/style.css';
import '@/components/Panels/Canvas/FloatingToolbars/NodeToolbar.css';

import type { EdgeStyle } from '@huabu/shared';

export async function mountEdgeToolbar(locale: string) {
  await i18n.changeLanguage(locale);
  const nodes = [
    { id: 'source', position: { x: 80, y: 200 }, data: { label: 'Source' } },
    { id: 'target', position: { x: 180, y: 400 }, data: { label: 'Target' } },
  ];
  let style: EdgeStyle = { strokeWidth: 4 };
  const edge = {
    id: 'fixture-edge',
    source: 'source',
    target: 'target',
    selected: true,
  };
  const edges = [{ ...edge, data: { edgeStyle: style } }];
  // Keep this visual fixture entirely in memory, away from persisted Spaces.
  useCanvasStore.setState({
    nodes,
    edges,
    executeCommands: (commands) => {
      for (const command of commands) {
        if (command.type !== 'SET_EDGE_STYLE') {
          throw new Error(`Unexpected fixture command: ${command.type}`);
        }
        style = { ...style, ...command.edges[0].style };
      }
      useCanvasStore.setState({
        edges: [{ ...edge, data: { edgeStyle: style } }],
      });
    },
  });
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;inset:0;background:var(--bg-default);z-index:900';
  document.body.append(host);
  createRoot(host).render(
    <ReactFlow nodes={nodes} edges={edges}>
      <EdgeStyleToolbar />
    </ReactFlow>,
  );
}
