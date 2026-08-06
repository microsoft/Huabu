// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import {
  getDescendantIds,
  syncInheritedContainerLocks,
  type NestableNode,
} from '../container/index.js';

import type { CanvasCommand } from '../../index.js';

/**
 * Toggles a node's locked state by flipping `data.locked`.
 *
 * When locked the node itself becomes non-draggable on the canvas.
 * It remains selectable so pointer events (e.g. double-click to expand)
 * still work; resize and content editing are blocked at the component level.
 * For Container nodes, all descendant nodes additionally become non-draggable.
 * Unlocking reverses all of the above.
 */
function toggleNodeLock(nodes: NestableNode[], nodeId: string): NestableNode[] {
  const target = nodes.find((n) => n.id === nodeId);
  if (!target) return nodes;

  const locked = Boolean(target.data?.locked);
  const nextLocked = !locked;

  const flagKey = '__dragDisabledByFrameLock';
  const descendantIds = new Set(getDescendantIds(nodes, nodeId));

  const updated = nodes.map((n) => {
    if (n.id === nodeId) {
      if (nextLocked) {
        const { selectable: _s, ...rest } = n;
        void _s;
        return {
          ...rest,
          draggable: false,
          className: [n.className, 'nopan'].filter(Boolean).join(' '),
          data: { ...(n.data ?? {}), locked: true },
        };
      }
      const { draggable: _d, selectable: _s, ...rest } = n;
      void _d;
      void _s;
      const prevClass =
        (n.className ?? '')
          .split(' ')
          .filter((c) => c !== 'nopan')
          .join(' ') || undefined;
      return {
        ...rest,
        ...(prevClass ? { className: prevClass } : {}),
        data: { ...(n.data ?? {}), locked: false },
      };
    }

    if (!descendantIds.has(n.id)) return n;

    if (nextLocked) {
      if (n.draggable === false) return n;
      return {
        ...n,
        draggable: false,
        data: {
          ...(n.data ?? {}),
          [flagKey]: true,
        },
      };
    }

    if ((n.data as Record<string, unknown> | undefined)?.[flagKey] !== true)
      return n;

    const dataObj = (n.data ?? {}) as Record<string, unknown>;
    const { [flagKey]: removedFlag, ...restData } = dataObj;
    void removedFlag;

    return {
      ...n,
      draggable: n.data?.locked === true ? false : true,
      data: restData,
    };
  });
  return syncInheritedContainerLocks(updated, nodeId);
}

type Cmd = Extract<CanvasCommand, { type: 'SET_NODE_LOCKED' }>;

const setNodeLocked: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: false,
  },

  handler(cmd, state) {
    if (cmd.items.length === 0) return noop(state);

    const lockMap = new Map(
      cmd.items.map((item) => [item.nodeId as string, item.locked]),
    );

    // Check that at least one target node exists.
    const anyExists = state.nodes.some((n) => lockMap.has(n.id));
    if (!anyExists) return noop(state, 'not-found');

    // For each item, use the toggleNodeLock utility which handles frame descendants.
    let result = state.nodes as NestableNode[];
    for (const item of cmd.items) {
      const id = item.nodeId as string;
      const node = result.find((n) => n.id === id);
      if (!node) continue;
      const currentLocked = node.data?.locked === true;
      if (currentLocked !== item.locked) {
        result = toggleNodeLock(result, id);
      }
    }

    return {
      applied: true,
      nodes: result,
      edges: state.edges,
    };
  },
};

export default setNodeLocked;
