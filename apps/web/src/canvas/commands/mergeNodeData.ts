import { noop, type CommandDefinition } from './types';
import { shouldPreprocessOnUpdate } from '../../utils/io/preprocess';

import type { BlockProvenanceMap, CanvasCommand } from '@sediment/shared';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'MERGE_NODE_DATA' }>;

/**
 * When the AI agent sends a `{ __all__: ... }` sentinel provenance, preserve
 * any existing per-block provenance entries alongside it so that the
 * NotePreview diff-merge logic can later match old blocks to new blocks and
 * carry over user-authored provenance for unchanged content.
 */
function mergeProvenance(
  existing: BlockProvenanceMap | undefined,
  incoming: BlockProvenanceMap | undefined,
): BlockProvenanceMap | undefined {
  if (!incoming) return existing;
  if (!existing || !('__all__' in incoming)) return incoming;

  // Incoming is a sentinel — combine with existing per-block entries.
  // Per-block entries keep their old keys; the __all__ sentinel signals that
  // a diff-merge is needed when the editor next loads.
  const hasPerBlock = Object.keys(existing).some((k) => k !== '__all__');
  if (!hasPerBlock) return incoming;

  return { ...existing, ...incoming };
}

const mergeNodeData: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: false,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.patches.length === 0) return noop(state);

    const patchMap = new Map(
      cmd.patches.map((p) => [p.nodeId as string, p.patch]),
    );
    const preprocessNodes: Node[] = [];
    let anyApplied = false;

    const nextNodes = state.nodes.map((n) => {
      const patch = patchMap.get(n.id);
      if (!patch) return n;
      anyApplied = true;
      const patchRec = patch as Record<string, unknown>;
      const dataRec = (n.data ?? {}) as Record<string, unknown>;
      const mergedProvenance = mergeProvenance(
        dataRec.provenance as BlockProvenanceMap | undefined,
        patchRec.provenance as BlockProvenanceMap | undefined,
      );

      const updated: Node = {
        ...n,
        data: {
          ...dataRec,
          ...patchRec,
          ...(mergedProvenance !== undefined
            ? { provenance: mergedProvenance }
            : {}),
        },
      };
      if (shouldPreprocessOnUpdate(n, updated)) {
        preprocessNodes.push(updated);
      }
      // When a child's label changes, the parent frame needs re-resolution.
      if (
        (patch as Record<string, unknown>).label !== undefined &&
        updated.parentId
      ) {
        const parentFrame = state.nodes.find(
          (pn) => pn.id === updated.parentId,
        );
        if (
          parentFrame &&
          !preprocessNodes.some((p) => p.id === parentFrame.id)
        ) {
          preprocessNodes.push(parentFrame);
        }
      }
      return updated;
    });

    if (!anyApplied) return noop(state, 'not-found');

    return {
      applied: true,
      nodes: nextNodes,
      edges: state.edges,
      preprocessNodes,
    };
  },
};

export default mergeNodeData;
