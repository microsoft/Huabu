// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isContainerNode } from './container/policy.js';
import { indexById } from './container/tree.js';
import { materializeForestOrder } from './container/zorder.js';

import type { CanvasNode } from './interfaces.js';

/** Complete direct-child lists; orderVersion is stamped by the commit owner. */
export interface SetSiblingOrderEvent {
  type: 'SET_SIBLING_ORDER';
  parentId: string | null;
  before: string[];
  after: string[];
  orderVersion: number;
}

/** Runtime guard reusable by API schemas without importing Zod into the engine. */
export function isSetSiblingOrderEvent(
  value: unknown,
): value is SetSiblingOrderEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  const isList = (list: unknown): list is string[] =>
    Array.isArray(list) &&
    list.every((id) => typeof id === 'string' && id.length > 0) &&
    new Set(list).size === list.length;
  return (
    Object.keys(event).length === 5 &&
    event.type === 'SET_SIBLING_ORDER' &&
    (event.parentId === null ||
      (typeof event.parentId === 'string' && event.parentId.length > 0)) &&
    isList(event.before) &&
    isList(event.after) &&
    typeof event.orderVersion === 'number' &&
    Number.isSafeInteger(event.orderVersion) &&
    event.orderVersion > 0
  );
}

export class SiblingOrderReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiblingOrderReplayError';
  }
}

export function sameSiblingOrder(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Validate new-protocol forests, never repair invalid topology as legacy loads do. */
export function collectSiblingOrders(
  nodes: readonly CanvasNode[],
): Map<string | null, string[]> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) {
    throw new SiblingOrderReplayError('Duplicate node IDs');
  }
  const lists = new Map<string | null, string[]>([[null, []]]);
  for (const node of nodes) {
    if (isContainerNode(node)) lists.set(node.id, []);
  }
  for (const node of nodes) {
    const parentId = node.parentId ?? null;
    const siblings = lists.get(parentId);
    if (!siblings) {
      throw new SiblingOrderReplayError(`Invalid parent of ${node.id}`);
    }
    siblings.push(node.id);
  }
  const pending = [...(lists.get(null) ?? [])];
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    const children = lists.get(id);
    if (children) for (const child of children) pending.push(child);
  }
  if (pending.length !== nodes.length) {
    throw new SiblingOrderReplayError('Cyclic parent membership');
  }
  return lists;
}

export function diffSiblingOrderEvents(
  previousNodes: readonly CanvasNode[],
  nextNodes: readonly CanvasNode[],
  orderVersion: number,
): SetSiblingOrderEvent[] {
  if (!Number.isSafeInteger(orderVersion) || orderVersion <= 0) {
    throw new SiblingOrderReplayError('Invalid order version');
  }
  const before = collectSiblingOrders(previousNodes);
  const after = collectSiblingOrders(nextNodes);
  const events: SetSiblingOrderEvent[] = [];
  for (const parentId of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(parentId) ?? [];
    const current = after.get(parentId) ?? [];
    if (
      before.has(parentId) !== after.has(parentId) ||
      !sameSiblingOrder(previous, current)
    ) {
      events.push({
        type: 'SET_SIBLING_ORDER',
        parentId,
        before: previous,
        after: current,
        orderVersion,
      });
    }
  }
  return events;
}

/** Install order only after the caller has applied every entity change in a commit. */
export function applySiblingOrderEvents(
  previousNodes: readonly CanvasNode[],
  nextNodes: readonly CanvasNode[],
  events: readonly SetSiblingOrderEvent[],
): CanvasNode[] {
  const before = collectSiblingOrders(previousNodes);
  const after = collectSiblingOrders(nextNodes);
  const orders = new Map<string | null, SetSiblingOrderEvent>();
  for (const event of events) {
    if (
      !isSetSiblingOrderEvent(event) ||
      orders.has(event.parentId) ||
      event.orderVersion !== events[0].orderVersion
    ) {
      throw new SiblingOrderReplayError(
        'Invalid or duplicate sibling order event',
      );
    }
    if (!sameSiblingOrder(before.get(event.parentId) ?? [], event.before)) {
      throw new SiblingOrderReplayError(
        `Stale sibling order: ${event.parentId}`,
      );
    }
    orders.set(event.parentId, event);
  }
  for (const parentId of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(parentId) ?? [];
    const current = after.get(parentId) ?? [];
    const members = new Set(current);
    const membershipChanged =
      before.has(parentId) !== after.has(parentId) ||
      previous.length !== current.length ||
      previous.some((id) => !members.has(id));
    if (membershipChanged && !orders.has(parentId)) {
      throw new SiblingOrderReplayError(`Missing sibling order: ${parentId}`);
    }
    if (!orders.has(parentId)) after.set(parentId, previous);
  }
  for (const [parentId, event] of orders) {
    const current = after.get(parentId) ?? [];
    const members = new Set(current);
    if (
      (!before.has(parentId) && !after.has(parentId)) ||
      event.after.length !== current.length ||
      event.after.some((id) => !members.has(id))
    ) {
      throw new SiblingOrderReplayError(
        `Sibling membership mismatch: ${parentId}`,
      );
    }
    after.set(parentId, event.after);
  }
  const byId = new Map(nextNodes.map((node) => [node.id, node]));
  const cursors = new Map<string | null, number>();
  const ordered = nextNodes.map((node) => {
    const parentId = node.parentId ?? null;
    const cursor = cursors.get(parentId) ?? 0;
    cursors.set(parentId, cursor + 1);
    const id = after.get(parentId)?.[cursor];
    const orderedNode = id === undefined ? undefined : byId.get(id);
    if (!orderedNode) {
      throw new SiblingOrderReplayError(
        `Missing sibling at ${parentId}:${cursor}`,
      );
    }
    return orderedNode;
  });
  return materializeForestOrder(ordered);
}

export type SiblingReorderTarget =
  | 'top'
  | 'bottom'
  | { before: string }
  | { after: string };

export type SiblingReorderAdmission =
  | { valid: true; parentId: string | null; before: string[]; after: string[] }
  | { valid: false; reason: 'invalid-target' | 'invalid-parent' };

export function hasUnlockedAncestry(
  byId: ReadonlyMap<string, CanvasNode>,
  nodeId: string,
): boolean {
  let node = byId.get(nodeId);
  const visited = new Set<string>();
  while (node) {
    if (visited.has(node.id) || node.data.locked) return false;
    visited.add(node.id);
    if (node.parentId === undefined || node.parentId === null) return true;
    node = byId.get(node.parentId);
    if (!isContainerNode(node)) return false;
  }
  return false;
}

/** Live-state admission; lifetime/ABA and writer-version guards belong to the server. */
export function admitSiblingReorder(
  nodes: CanvasNode[],
  nodeIds: readonly string[],
  to: SiblingReorderTarget,
): SiblingReorderAdmission {
  const byId = indexById(nodes);
  const moving = new Set(nodeIds);
  if (
    moving.size === 0 ||
    moving.size !== nodeIds.length ||
    nodeIds.some((id) => !byId.has(id))
  ) {
    return { valid: false, reason: 'invalid-target' };
  }
  const first = byId.get(nodeIds[0]);
  if (!first) return { valid: false, reason: 'invalid-target' };
  const parentId = first.parentId ?? null;
  if (
    nodeIds.some((id) => {
      const node = byId.get(id);
      return (
        !node ||
        (node.parentId ?? null) !== parentId ||
        !hasUnlockedAncestry(byId, id)
      );
    })
  ) {
    return { valid: false, reason: 'invalid-parent' };
  }
  const before = nodes
    .filter((node) => (node.parentId ?? null) === parentId)
    .map((node) => node.id);
  const group = before.filter((id) => moving.has(id));
  const rest = before.filter((id) => !moving.has(id));
  let index = to === 'bottom' ? 0 : rest.length;
  if (typeof to === 'object') {
    const anchorId = 'before' in to ? to.before : to.after;
    index = rest.indexOf(anchorId);
    if (index === -1) return { valid: false, reason: 'invalid-target' };
    if ('after' in to) index++;
  }
  const after = [...rest.slice(0, index), ...group, ...rest.slice(index)];
  return { valid: true, parentId, before, after };
}
