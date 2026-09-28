// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  Background,
  Panel,
  ReactFlow,
  useNodesState,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';

import { Button } from '@/components/Common/Button';
import { CanvasZoomMenu } from '@/components/Panels/Canvas/CanvasZoomMenu';
import { MAX_ZOOM, MIN_ZOOM } from '@/config/canvas';
import { useCanvasShortcuts } from '@/hooks/shortcuts/useCanvasShortcuts';
import { i18n } from '@/i18n';

function FixtureControls() {
  const instance = useReactFlow();
  const rfInstanceRef = useRef(instance);
  const mousePositionRef = useRef({ x: 0, y: 0 });
  useCanvasShortcuts({ rfInstanceRef, mousePositionRef });
  const zoom = useStore((state) => state.transform[2]);
  return (
    <Panel position="top-left" className="flex gap-3">
      <output data-zoom-value>{zoom}</output>
      <Button
        onClick={() =>
          instance.setNodes((nodes) =>
            nodes.map((node) => ({ ...node, selected: false })),
          )
        }
      >
        Clear selection
      </Button>
      <Button onClick={() => instance.setNodes([])}>Clear canvas</Button>
    </Panel>
  );
}

function CanvasZoomFixture() {
  const [nodes, , onNodesChange] = useNodesState([
    {
      id: 'near',
      position: { x: 300, y: 180 },
      data: { label: 'Near node' },
      style: { width: 180, height: 100 },
    },
    {
      id: 'far',
      position: { x: 4000, y: 180 },
      data: { label: 'Selected offscreen node' },
      selected: true,
      style: { width: 180, height: 100 },
    },
  ]);
  return (
    <ReactFlow
      nodes={nodes}
      onNodesChange={onNodesChange}
      defaultViewport={{ x: 0, y: 0, zoom: 0.43 }}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      onlyRenderVisibleElements
    >
      <Background />
      <FixtureControls />
      <CanvasZoomMenu />
    </ReactFlow>
  );
}

export async function mountCanvasZoomFixture(language = 'en') {
  await i18n.changeLanguage(language);
  const host = document.createElement('div');
  host.dataset.canvasRoot = '';
  host.tabIndex = -1;
  host.style.cssText =
    'position:fixed;inset:0;background:var(--bg-default);z-index:9000';
  document.body.append(host);
  createRoot(host).render(<CanvasZoomFixture />);
  host.focus();
}
