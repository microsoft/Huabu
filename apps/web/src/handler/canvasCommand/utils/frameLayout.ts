/**
 * @file Frame layout helpers — read the layout config persisted on a
 * frame node and translate the pure-compute grid layout results from
 * `@sediment/shared/canvas-engine` into explicit canvas commands so
 * structured frames stay consistent after a child change.
 *
 * `AUTO_LAYOUT` no longer exists as a command (see CHANGELOG
 * 2026-05-24); we emit `SET_NODE_GEOMETRY` (positions + frame size)
 * and `MERGE_NODE_DATA` (`frameSlot` updates) so structured re-flows
 * share the same undo step as the gesture that triggered them.
 */

import {
  applyColumnLayout,
  applyRowLayout,
  readFrameGridConfig,
} from '@sediment/shared/canvas-engine';

import type {
  CanvasCommand,
  CanvasNodeId,
  CanvasNodeDataMergePatch,
  CanvasNodeGeometryUpdate,
  FrameLayoutMode,
} from '@sediment/shared';
import type { Node } from '@xyflow/react';

/**
 * Description of changes about to land in the same command batch as
 * the relayout — used to pre-apply them to a working copy so the
 * structured layout pass sees the same world the executor will see.
 *
 * Without this, the relayout would read stale `parentId` / `frameSlot`
 * values from `ui.nodes` and miss newly-arrived children or assign
 * them to the wrong track.
 */
export interface PendingFrameMutations {
  /**
   * Direct child → new parent. Pass `null` to detach. Mirrors the
   * `SET_NODE_PARENT` command emitted by callers.
   */
  parentChanges?: ReadonlyMap<string, string | null>;
  /** Direct child → new `frameSlot`. Mirrors a `MERGE_NODE_DATA` patch. */
  slotPatches?: ReadonlyArray<{ nodeId: string; slot: number }>;
  /**
   * Frame → layout-mode + gridCount patch. Mirrors the
   * `MERGE_NODE_DATA` emitted by `SET_FRAME_LAYOUT_MODE`.
   */
  frameDataPatches?: ReadonlyArray<{
    nodeId: string;
    patch: Record<string, unknown>;
  }>;
}

/**
 * Apply a set of pending mutations to a node array and return a fresh
 * copy. Pure / non-mutating: the input is left untouched.
 *
 * Only mutates the fields the caller explicitly named (parentId,
 * frameSlot, layoutMode/gridCount). Everything else is preserved by
 * reference — this is intentionally lighter than `executor.execute`
 * because we only need enough fidelity for the grid layout pass.
 */
function applyPendingMutations(
  nodes: Node[],
  pending: PendingFrameMutations,
): Node[] {
  const { parentChanges, slotPatches, frameDataPatches } = pending;
  if (
    (!parentChanges || parentChanges.size === 0) &&
    (!slotPatches || slotPatches.length === 0) &&
    (!frameDataPatches || frameDataPatches.length === 0)
  ) {
    return nodes;
  }

  const slotById = new Map<string, number>();
  if (slotPatches) {
    for (const p of slotPatches) slotById.set(p.nodeId, p.slot);
  }
  const frameDataById = new Map<string, Record<string, unknown>>();
  if (frameDataPatches) {
    for (const p of frameDataPatches) frameDataById.set(p.nodeId, p.patch);
  }

  return nodes.map((n) => {
    let next = n;
    if (parentChanges?.has(n.id)) {
      const nextParent = parentChanges.get(n.id);
      next = {
        ...next,
        ...(nextParent ? { parentId: nextParent } : { parentId: undefined }),
      };
    }
    if (slotById.has(n.id)) {
      next = {
        ...next,
        data: { ...(next.data ?? {}), frameSlot: slotById.get(n.id) },
      };
    }
    const framePatch = frameDataById.get(n.id);
    if (framePatch) {
      next = {
        ...next,
        data: { ...(next.data ?? {}), ...framePatch },
      };
    }
    return next;
  });
}

/**
 * Read the layout mode persisted on a frame node. Returns `'free'` for
 * non-frame nodes, undefined nodes, or frames with no explicit mode set.
 */
export function getFrameLayoutMode(node: Node | undefined): FrameLayoutMode {
  if (!node || node.type !== 'frame') return 'free';
  const mode = (node.data as { layoutMode?: FrameLayoutMode } | undefined)
    ?.layoutMode;
  return mode ?? 'free';
}

/**
 * Build follow-up commands that re-flow any structured frames in
 * `frameIds`. Free-mode frames are skipped (they manage their own
 * positioning).
 *
 * When the caller is about to emit other commands in the same batch
 * (parent changes, slot patches, frame mode changes), pass them via
 * `pending` so the layout pass sees the post-batch world — otherwise
 * the relayout reads stale `parentId` / `frameSlot` / `layoutMode`
 * from `nodes` and either misses newly-arrived children or assigns
 * them to the wrong track.
 *
 * Returns a single `MERGE_NODE_DATA` (slot patches) and a single
 * `SET_NODE_GEOMETRY` (child positions + frame sizes) command — one
 * of each, even when multiple frames need a re-flow, so the resulting
 * batch stays compact.
 */
export function buildStructuredFrameRelayoutCommands(
  frameIds: Iterable<string>,
  nodes: Node[],
  pending: PendingFrameMutations = {},
): CanvasCommand[] {
  const workingNodes = applyPendingMutations(nodes, pending);
  const seen = new Set<string>();
  const geometryItems: CanvasNodeGeometryUpdate[] = [];
  const dataPatches: CanvasNodeDataMergePatch[] = [];

  for (const id of frameIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const frame = workingNodes.find((n) => n.id === id);
    const cfg = readFrameGridConfig(frame);
    if (!cfg) continue;

    const result =
      cfg.axis === 'column'
        ? applyColumnLayout(workingNodes, id, cfg.count)
        : applyRowLayout(workingNodes, id, cfg.count);
    if (!result) continue;

    // Child positions (only when they actually move).
    for (const [nodeId, target] of result.childPositions) {
      const node = workingNodes.find((n) => n.id === nodeId);
      if (!node) continue;
      if (node.position.x === target.x && node.position.y === target.y) {
        continue;
      }
      geometryItems.push({
        nodeId: nodeId as CanvasNodeId,
        position: { x: target.x, y: target.y },
      });
    }

    // Frame size — only emit when it actually changed.
    const curW = (frame?.style as { width?: number } | undefined)?.width;
    const curH = (frame?.style as { height?: number } | undefined)?.height;
    if (curW !== result.frameSize.width || curH !== result.frameSize.height) {
      geometryItems.push({
        nodeId: id as CanvasNodeId,
        size: {
          width: result.frameSize.width,
          height: result.frameSize.height,
        },
      });
    }

    // Slot writes — only when the value differs from what's stored on
    // the working copy (which already reflects `pending.slotPatches`).
    for (const [nodeId, slot] of result.slotAssignments) {
      const node = workingNodes.find((n) => n.id === nodeId);
      if (!node) continue;
      const prior = (node.data as { frameSlot?: number } | undefined)
        ?.frameSlot;
      if (typeof prior === 'number' && prior === slot) continue;
      dataPatches.push({
        nodeId: nodeId as CanvasNodeId,
        patch: { frameSlot: slot },
      });
    }

    // Frame gridCount — the layout uses the `'compact'` policy here, so a
    // drag that vacated a track shrinks the count. Persist it so the
    // stored value and the UI stepper stay in sync.
    const priorGrid = (frame?.data as { gridCount?: number } | undefined)
      ?.gridCount;
    if (priorGrid !== result.effectiveCount) {
      dataPatches.push({
        nodeId: id as CanvasNodeId,
        patch: { gridCount: result.effectiveCount },
      });
    }
  }

  const commands: CanvasCommand[] = [];
  if (dataPatches.length > 0) {
    commands.push({ type: 'MERGE_NODE_DATA', patches: dataPatches });
  }
  if (geometryItems.length > 0) {
    commands.push({ type: 'SET_NODE_GEOMETRY', items: geometryItems });
  }
  return commands;
}
