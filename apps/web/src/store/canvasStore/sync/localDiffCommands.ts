// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Commands for changes that reached the store without one.
 *
 * Some writers move the store directly: live drag and resize ticks, the
 * preview passes that follow a resize, and style patches applied during a
 * gesture. Their result has to reach the server as commands, so it is read
 * back from the difference between two node lists.
 *
 * Covered: position, size, non-content `data` keys and `data.style` leaves
 * of nodes present in both lists. Not covered (left to the commands the
 * caller already has, or reported as `uncovered`): created and deleted
 * nodes, a changed parent, sibling order, removed `data` keys, and other
 * top-level node fields.
 *
 * Pure functions only.
 */

import {
  changedUnits,
  PARENT_UNIT,
  POSITION_UNIT,
  readUnit,
  SIZE_UNIT,
  type UnitNode,
} from './propertyUnits';

import type { CanvasCommand, CanvasNodeId } from '@huabu/shared';

type GeometryItem = Extract<
  CanvasCommand,
  { type: 'SET_NODE_GEOMETRY' }
>['items'][number];
type DataPatch = Extract<
  CanvasCommand,
  { type: 'MERGE_NODE_DATA' }
>['patches'][number];

export interface LocalDiffCommands {
  commands: CanvasCommand[];
  /** Changes this module cannot express as a command, as `nodeId:unit`. */
  uncovered: string[];
}

const DATA_STYLE_PREFIX = 'data.style.';
const DATA_PREFIX = 'data.';

function numericSize(
  node: UnitNode,
): { width: number; height?: number } | null {
  const style = node.style as Record<string, unknown> | undefined;
  const width = style?.width;
  if (typeof width !== 'number') return null;
  const height = style?.height;
  return typeof height === 'number' ? { width, height } : { width };
}

/**
 * Commands that take `prev` to `next` for the fields listed above.
 *
 * @param ignoreUnit Units another writer persists (content fields).
 */
export function commandsForLocalDiff(
  prev: readonly UnitNode[],
  next: readonly UnitNode[],
  ignoreUnit: (unit: string) => boolean = () => false,
): LocalDiffCommands {
  const items: GeometryItem[] = [];
  const patches: DataPatch[] = [];
  const uncovered: string[] = [];
  if (prev === next) return { commands: [], uncovered };

  const before = new Map(prev.map((node) => [node.id, node]));
  for (const node of next) {
    const start = before.get(node.id);
    if (!start || start === node) continue;
    const units = changedUnits(start, node).filter((u) => !ignoreUnit(u));
    if (units.length === 0) continue;

    const item: { position?: unknown; size?: unknown } = {};
    const patch: Record<string, unknown> = {};
    const style: Record<string, unknown> = {};
    for (const unit of units) {
      if (unit === POSITION_UNIT) {
        item.position = node.position;
      } else if (unit === SIZE_UNIT) {
        const size = numericSize(node);
        if (size) item.size = size;
        else uncovered.push(`${node.id}:${unit}`);
      } else if (unit === PARENT_UNIT) {
        uncovered.push(`${node.id}:${unit}`);
      } else if (unit.startsWith(DATA_STYLE_PREFIX)) {
        const value = readUnit(node, unit);
        if (value.present)
          style[unit.slice(DATA_STYLE_PREFIX.length)] = value.value;
        else uncovered.push(`${node.id}:${unit}`);
      } else if (unit.startsWith(DATA_PREFIX)) {
        const value = readUnit(node, unit);
        if (value.present) patch[unit.slice(DATA_PREFIX.length)] = value.value;
        else uncovered.push(`${node.id}:${unit}`);
      } else {
        uncovered.push(`${node.id}:${unit}`);
      }
    }
    if (Object.keys(style).length > 0) patch.style = style;
    if (item.position !== undefined || item.size !== undefined) {
      items.push({
        nodeId: node.id as CanvasNodeId,
        ...item,
      } as GeometryItem);
    }
    if (Object.keys(patch).length > 0) {
      patches.push({ nodeId: node.id as CanvasNodeId, patch } as DataPatch);
    }
  }

  const commands: CanvasCommand[] = [];
  if (items.length > 0) commands.push({ type: 'SET_NODE_GEOMETRY', items });
  if (patches.length > 0) commands.push({ type: 'MERGE_NODE_DATA', patches });
  return { commands, uncovered };
}
