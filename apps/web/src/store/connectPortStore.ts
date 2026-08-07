// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import type {
  ConnectedNodePlacement,
  Side,
} from '@/components/Nodes/NodeConnectAffordance.tsx';

/**
 * A "create a connected node" gesture whose geometry is already resolved
 * and that is only waiting on a node type.
 */
export interface PendingConnectGesture {
  /** Node the gesture started from. */
  sourceId: string;
  /** Port the gesture left the source node through. */
  side: Side;
  /**
   * Flow-space point the gesture ended at: the picker is anchored here,
   * and for a drag it is also where the new node goes.
   */
  anchor: { x: number; y: number };
  /**
   * `'point'` for a drag released on empty canvas, `'side'` for a plain
   * port click. Everything else the pending gesture needs — placement,
   * whether to draw a tether — follows from this plus `side`/`anchor`.
   */
  kind: ConnectedNodePlacement['kind'];
}

interface ConnectPortState {
  /** The gesture waiting on a node type, or `null` when none is pending. */
  pending: PendingConnectGesture | null;
  setPending: (gesture: PendingConnectGesture | null) => void;
}

/**
 * The pending connect gesture, shared between the canvas — which resolves
 * the geometry and renders the picker — and every node's ports, which pin
 * the originating port and stand their floating toolbar down while it is
 * open.
 *
 * A store rather than a React context: the consumers are node components
 * React Flow renders as descendants, so a provider would have to wrap the
 * entire flow, re-rendering every node whenever the value changes and
 * nesting the whole canvas subtree one level deeper for what is a single
 * nullable record. Selector subscriptions give each node exactly the slice
 * it cares about instead. Mirrors `canvasAttentionStore` and
 * `nodeCollapseStore`.
 */
export const useConnectPortStore = create<ConnectPortState>((set) => ({
  pending: null,
  setPending: (gesture) => set({ pending: gesture }),
}));
