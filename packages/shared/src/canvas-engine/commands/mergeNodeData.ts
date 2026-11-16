// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import { isFileReference } from '../../utils/file-reference.js';
import {
  hasAgentNodeOwnedData,
  changesAgentNodePreparation,
} from '../agentNodeOwnership.js';
import {
  hasValidNodeProperties,
  mergeNodeProperties,
} from '../nodeProperties.js';
import { validPdfNoteLink } from '../pdfNotes.js';
import { hasValidInkResourceBindings } from '../utils/inkSigil.js';

import type { CanvasCommand } from '../../index.js';
import type {
  NodeProperties,
  NodePropertiesPatch,
} from '../../types/api/canvas.js';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'MERGE_NODE_DATA' }>;

const STYLE_LEAF_PREFIX = 'style.';

/** The keys an `unset` list removes, as a patch that names them. */
function unsetAsPatch(unset: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    unset.map((key) => [
      key.startsWith(STYLE_LEAF_PREFIX) ? 'style' : key,
      null,
    ]),
  );
}

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
    const linkedNodes = cmd.patches.some((entry) => 'noteNodeId' in entry.patch)
      ? state.nodes.map((node) => {
          const patch = patchMap.get(node.id);
          return patch && 'noteNodeId' in patch
            ? { ...node, data: { ...node.data, noteNodeId: patch.noteNodeId } }
            : node;
        })
      : state.nodes;
    for (const entry of cmd.patches) {
      if (!hasValidNodeProperties(entry.patch, true))
        return noop(state, 'invalid-target');
      const node = state.nodes.find(
        (candidate) => candidate.id === entry.nodeId,
      );
      if (entry.unset?.length) {
        // A page's way to state a removal; an agent clears with `null`.
        if (state.source === 'agent') return noop(state, 'invalid-scope');
        if (!entry.unset.every((key) => typeof key === 'string' && key))
          return noop(state, 'invalid-target');
        // A removal is admitted like a write of the same key.
        const removed = unsetAsPatch(entry.unset);
        if (
          node?.type === 'fileReference' &&
          ['content', 'src', 'fileReference'].some((key) => key in removed)
        )
          return noop(state, 'invalid-target');
        if (
          node?.type === 'question' &&
          (hasAgentNodeOwnedData(removed) ||
            (node.data.bindingState === 'bound' &&
              changesAgentNodePreparation(node.data, removed)))
        )
          return noop(state, 'invalid-target');
      }
      if (
        node &&
        'noteNodeId' in entry.patch &&
        !validPdfNoteLink(node, entry.patch.noteNodeId, linkedNodes)
      )
        return noop(state, 'invalid-target');
      if (
        node?.type === 'spacePreview' &&
        ['properties', 'propertyDisplayKeys'].some((key) => key in entry.patch)
      )
        return noop(state, 'invalid-target');
      if (
        node?.type === 'fileReference' &&
        (['content', 'src'].some((key) => key in entry.patch) ||
          ('fileReference' in entry.patch &&
            !isFileReference(entry.patch.fileReference)))
      )
        return noop(state, 'invalid-target');
      if (node?.type === 'sketch' && !hasValidInkResourceBindings(entry.patch))
        return noop(state, 'invalid-target');
      if (node?.type === 'question' && hasAgentNodeOwnedData(entry.patch))
        return noop(state, 'invalid-target');
      if (
        node?.type === 'question' &&
        node.data.bindingState === 'bound' &&
        changesAgentNodePreparation(node.data, entry.patch)
      )
        return noop(state, 'invalid-target');
    }

    const unsetMap = new Map(
      cmd.patches.flatMap((p) =>
        p.unset?.length ? [[p.nodeId as string, p.unset] as const] : [],
      ),
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
      // footgun. Pass `style: null` to clear the whole bag explicitly.
      // Question patches omit undefined; other nodes also allow it to clear.
      const mergedData: Record<string, unknown> = {
        ...dataRec,
        ...(n.type === 'question'
          ? Object.fromEntries(
              Object.entries(patchRec).filter(
                ([, value]) => value !== undefined,
              ),
            )
          : patchRec),
      };
      if (n.type === 'question' && patchRec.agentLaunchOverrides === null)
        delete mergedData.agentLaunchOverrides;
      // JSON transports cannot carry `undefined`, so `null` clears the cover.
      if (patchRec.coverUrl === null) delete mergedData.coverUrl;
      if (patchRec.properties !== undefined) {
        mergedData.properties = mergeNodeProperties(
          dataRec.properties as NodeProperties | undefined,
          patchRec.properties as NodePropertiesPatch,
        );
      }
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
        // `null` is the explicit clear-all signal.
      }
      for (const key of unsetMap.get(n.id) ?? []) {
        if (!key.startsWith(STYLE_LEAF_PREFIX)) {
          delete mergedData[key];
          continue;
        }
        const style = mergedData.style;
        if (!style || typeof style !== 'object') continue;
        const { [key.slice(STYLE_LEAF_PREFIX.length)]: _removed, ...rest } =
          style as Record<string, unknown>;
        void _removed;
        // An emptied bag is dropped, as on a node that never had one.
        if (Object.keys(rest).length > 0) mergedData.style = rest;
        else delete mergedData.style;
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
