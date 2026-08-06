// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Read who currently owns a node's height, straight from the React Flow
 * store.
 *
 * Height ownership used to be re-derived at every use site as
 * `style.height !== undefined`. That check stops working the moment an
 * auto node carries a materialized number — which is exactly what the
 * height ownership model introduces — so every site that asks "is this
 * auto?" must go through the shared resolver instead.
 *
 * Returns a plain string, so the default `Object.is` equality already
 * prevents a re-render when an unrelated part of the node changes.
 */

import { useStore } from '@xyflow/react';

import { resolveHeightMode } from '@huabu/shared/canvas-engine';

import type { HeightMode } from '@huabu/shared';

/**
 * Height owner for a node, or `'auto'` while the node is not in the
 * store (a transient state during mount/unmount). The fallback is the
 * safe direction: it never claims a user pinned a height they did not.
 */
export function useHeightMode(nodeId: string): HeightMode {
  return useStore((s) => {
    const node = s.nodeLookup.get(nodeId);
    return node ? resolveHeightMode(node) : 'auto';
  });
}
