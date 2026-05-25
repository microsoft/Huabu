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
 * Returns a single `SET_NODE_GEOMETRY` (child positions + frame sizes)
 * and a single `MERGE_NODE_DATA` (slot patches) command — one of each,
 * even when multiple frames need a re-flow, so the resulting batch
 * stays compact.
 */
export function buildStructuredFrameRelayoutCommands(
  frameIds: Iterable<string>,
  nodes: Node[],
): CanvasCommand[] {
  const seen = new Set<string>();
  const geometryItems: CanvasNodeGeometryUpdate[] = [];
  const dataPatches: CanvasNodeDataMergePatch[] = [];

  for (const id of frameIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const frame = nodes.find((n) => n.id === id);
    const cfg = readFrameGridConfig(frame);
    if (!cfg) continue;

    const result =
      cfg.axis === 'column'
        ? applyColumnLayout(nodes, id, cfg.count)
        : applyRowLayout(nodes, id, cfg.count);
    if (!result) continue;

    // Child positions (only when they actually move).
    for (const [nodeId, target] of result.childPositions) {
      const node = nodes.find((n) => n.id === nodeId);
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

    // Slot writes — only when the value differs from what's stored.
    for (const [nodeId, slot] of result.slotAssignments) {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      const prior = (node.data as { frameSlot?: number } | undefined)
        ?.frameSlot;
      if (typeof prior === 'number' && prior === slot) continue;
      dataPatches.push({
        nodeId: nodeId as CanvasNodeId,
        patch: { frameSlot: slot },
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
