// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';

import type { CanvasCommand } from '../../index.js';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'MERGE_NODE_DATA' }>;

const mergeNodeData: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: false,
  },

  handler(cmd, state) {
    if (cmd.patches.length === 0) return noop(state);

    const patchMap = new Map(
      cmd.patches.map((p) => [p.nodeId as string, p.patch]),
    );
    // Every node whose data we actually patched, plus any parent frame
    // whose child label changed. The engine doesn't filter by watched
    // fields — the server's preprocessing dispatcher does that against
    // the per-type profile.
    const mutatedNodes: Node[] = [];
    const contentEditedNodeIds: string[] = [];
    let anyApplied = false;

    const nextNodes = state.nodes.map((n) => {
      const patch = patchMap.get(n.id);
      if (!patch) return n;
      anyApplied = true;
      const patchRec = patch as Record<string, unknown>;
      const dataRec = (n.data ?? {}) as Record<string, unknown>;

      // `data` merges shallowly; `data.style` merges one level deeper.
      // Top-level fields (`label`, `content`, `provenance`, …) are owned
      // by independent code paths so a shallow replace is the right
      // semantics. `style`, however, is a *bag* of visual fields
      // (`accent`, `fontFamily`, `fontSize`, …) and the natural caller
      // intent — including every LLM-issued restyle — is "change this
      // one knob, leave the rest alone". A shallow replace there would
      // silently wipe sibling style fields (the exact bug surfaced in
      // 2026-06-17 when an AI accent patch was erasing user-set font
      // sizes). Deep-merging at this single key keeps the predictable
      // shallow-merge contract everywhere else while plugging that
      // footgun. Pass `style: undefined` (or `null`) to clear the whole
      // bag explicitly.
      const mergedData: Record<string, unknown> = {
        ...dataRec,
        ...patchRec,
      };
      if ('style' in patchRec) {
        const incomingStyle = patchRec.style;
        if (incomingStyle && typeof incomingStyle === 'object') {
          const existingStyle =
            dataRec.style && typeof dataRec.style === 'object'
              ? (dataRec.style as Record<string, unknown>)
              : {};
          mergedData.style = {
            ...existingStyle,
            ...(incomingStyle as Record<string, unknown>),
          };
        }
        // `null` / `undefined` flow through unchanged as a clear-all signal.
      }

      const updated: Node = {
        ...n,
        data: mergedData,
      };
      mutatedNodes.push(updated);
      // Engine-neutral fact: the node's `content` field was rewritten.
      // Hosts decide what to do with this (web/agent batches use it to
      // flag AI-authored rewrites for the editor; other hosts ignore it).
      if (typeof patchRec.content === 'string') {
        contentEditedNodeIds.push(n.id);
      }
      // When a child's label changes, the parent frame needs re-resolution.
      if (
        (patch as Record<string, unknown>).label !== undefined &&
        updated.parentId
      ) {
        const parentFrame = state.nodes.find(
          (pn) => pn.id === updated.parentId,
        );
        if (parentFrame && !mutatedNodes.some((p) => p.id === parentFrame.id)) {
          mutatedNodes.push(parentFrame);
        }
      }
      return updated;
    });

    if (!anyApplied) return noop(state, 'not-found');

    return {
      applied: true,
      nodes: nextNodes,
      edges: state.edges,
      mutatedNodes,
      ...(contentEditedNodeIds.length > 0 ? { contentEditedNodeIds } : {}),
    };
  },
};

export default mergeNodeData;
