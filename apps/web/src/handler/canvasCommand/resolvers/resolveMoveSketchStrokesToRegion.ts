// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createId, type CanvasNodeId } from '@huabu/shared';

import { buildSketchStrokeTransferCommands } from '@/components/Nodes/sketch/sketchMerge';

import { resolveFrameAtPoint } from '../utils';

import type {
  CanvasUiIntent,
  UiIntentResolution,
  UiResolverState,
} from '../uiIntent';
import type { NestableNode } from '@huabu/shared/canvas-engine';

/**
 * Resolver for `MOVE_SKETCH_STROKES_TO_REGION` (Stage 4B).
 *
 * Stroke-level split / cross-region move: pull the given strokes out of
 * their source region(s) and re-home them either into an existing region
 * (`targetNodeId`) or a brand-new region (`targetNodeId === null`). Delegates
 * the geometry to the pure {@link buildSketchStrokeTransferCommands} builder,
 * which reuses `computeEraseCommands` for the source side (survivor reflow /
 * delete-when-emptied) and works in absolute flow coordinates so a transfer
 * across frame boundaries lands correctly.
 *
 * Degrades gracefully: sources that have disappeared or are no longer sketch
 * nodes are dropped, and the builder returns `[]` when nothing meaningful
 * would move (so strokes are never deleted without being re-homed).
 *
 * Trace is intentionally empty for now (mirrors `resolveMoveNoteBlockIntoNote`);
 * agent-visible provenance for handwriting reorganisation can be added later
 * without touching this shape.
 */
export default function resolveMoveSketchStrokesToRegion(
  intent: Extract<CanvasUiIntent, { type: 'MOVE_SKETCH_STROKES_TO_REGION' }>,
  ui: UiResolverState,
): UiIntentResolution {
  // Keep only sources still present, still sketch, with strokes to move.
  const sources = intent.sources
    .map((s) => ({
      nodeId: s.nodeId as CanvasNodeId,
      strokeIds: s.strokeIds,
    }))
    .filter((s) => {
      if (s.strokeIds.length === 0) return false;
      const node = ui.nodes.find((n) => n.id === s.nodeId);
      return node?.type === 'sketch';
    });

  if (sources.length === 0) return { commands: [], trace: [] };

  // Split (targetNodeId === null): auto-nest the new region under whatever
  // frame the drop point lands in — same helper `resolveAddNodes` uses when
  // a node is dropped onto a frame. Merge: the moved strokes adopt the
  // target's own parent, so no drop-point hit-test is needed.
  const destParentId =
    intent.targetNodeId === null
      ? ((resolveFrameAtPoint(ui.nodes as NestableNode[], intent.dropPoint)
          ?.parentId ?? null) as CanvasNodeId | null)
      : null;

  const commands = buildSketchStrokeTransferCommands({
    nodes: ui.nodes,
    sources,
    dropDelta: intent.dropDelta,
    targetNodeId: (intent.targetNodeId as CanvasNodeId | null) ?? null,
    newNodeId: createId('node') as CanvasNodeId,
    destParentId,
  });

  return { commands, trace: [] };
}
