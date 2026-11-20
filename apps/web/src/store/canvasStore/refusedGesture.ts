// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { hasUnlockedAncestry } from '@huabu/shared/canvas-engine';

import { toast } from '@/components/Common/Toast';
import { i18n } from '@/i18n';

import type { CanvasCommand, CanvasEditResult } from '@huabu/shared';
import type { Node } from '@xyflow/react';

/** The hint a refused gesture shows, as a key of the `canvasGesture` texts. */
export type RefusedGestureHint =
  | 'canvasGesture.lockedGroup'
  | 'canvasGesture.locked'
  | 'canvasGesture.refused';

type AncestryIndex = Parameters<typeof hasUnlockedAncestry>[0];

/** The nodes a command checks for a lock before it changes anything. */
function lockCheckedIds(command: CanvasCommand): readonly (string | null)[] {
  switch (command.type) {
    case 'SET_NODE_PARENT':
      return [...command.nodeIds, command.parentId];
    case 'REORDER_NODES':
      return command.nodeIds;
    case 'SET_FRAME_LAYOUT':
      return [command.frameId];
    default:
      return [];
  }
}

/**
 * What to tell the person about a gesture the engine refused as a whole, or
 * `null` when there is nothing to tell.
 *
 * @param commands The commands of the gesture, as they were run.
 * @param edit The engine's result for them; `applied` is false.
 * @param nodes The nodes the gesture was run against.
 */
export function refusedGestureHint(
  commands: readonly CanvasCommand[],
  edit: CanvasEditResult,
  nodes: readonly Node[],
): RefusedGestureHint | null {
  // The target is gone already (deleted here or by another page, or a late
  // write to a removed node): there is nothing the person could do about it.
  if (edit.reason === 'not-found') return null;
  const failed =
    edit.failedAt === undefined ? undefined : commands[edit.failedAt];
  if (!failed) return 'canvasGesture.refused';

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const locked = lockCheckedIds(failed).some(
    (id) =>
      id !== null &&
      byId.has(id) &&
      !hasUnlockedAncestry(byId as unknown as AncestryIndex, id),
  );
  if (!locked) return 'canvasGesture.refused';
  // Moving nodes into a Frame the same gesture creates is grouping them.
  const groups =
    failed.type === 'SET_NODE_PARENT' &&
    failed.parentId !== null &&
    !byId.has(failed.parentId);
  return groups ? 'canvasGesture.lockedGroup' : 'canvasGesture.locked';
}

/** A key held down or a double press is one attempt. */
const REPEAT_WINDOW_MS = 1_500;

let lastHint: RefusedGestureHint | null = null;
let lastShownAt = 0;

/** Tell the person, once per attempt, that the gesture changed nothing. */
export function showRefusedGestureHint(hint: RefusedGestureHint): void {
  const now = Date.now();
  if (lastHint === hint && now - lastShownAt < REPEAT_WINDOW_MS) return;
  lastHint = hint;
  lastShownAt = now;
  // A warning toast dismisses itself (see `Toast`).
  toast(i18n.t(hint), { tone: 'warning' });
}
