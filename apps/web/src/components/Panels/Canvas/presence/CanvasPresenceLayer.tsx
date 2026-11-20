// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStore } from '@xyflow/react';
import { createPortal } from 'react-dom';

import { RemoteCursors } from './RemoteCursors';
import { RemoteNodeOutlines } from './RemoteNodeOutlines';
import { useReportCanvasPresence } from './useReportCanvasPresence';

/**
 * Space presence on the canvas: reports this page's pointer and node
 * activity, and draws the other pages' cursors and node outlines as a
 * screen-space layer portalled into the `.react-flow` container, the same
 * way `SelectionOutlines` draws this page's own.
 *
 * Mounted inside `<ReactFlow>`. Presence is ephemeral and lives in its own
 * store; see `docs/architecture/canvas-realtime-sync.md`.
 */
export function CanvasPresenceLayer() {
  const domNode = useStore((state) => state.domNode);
  useReportCanvasPresence(domNode);
  if (!domNode) return null;
  return createPortal(
    <>
      <RemoteNodeOutlines domNode={domNode} />
      <RemoteCursors />
    </>,
    domNode,
  );
}
