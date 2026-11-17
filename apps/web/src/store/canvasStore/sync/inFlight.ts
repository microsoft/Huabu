// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * In-flight set: which (entity, property unit) pairs this page has changed
 * and not yet had confirmed by the server.
 *
 * Keys are derived from the local pre/post diff of each sent batch (see
 * {@link deriveHeldKeys}), not from the command list: the diff also covers
 * what the engine changed as a consequence (a frame refit, a sibling pushed
 * by a layout pass), and it needs no per-command table to stay in step with
 * the engine.
 *
 * A remote value for a held key is not applied; it is kept here so it can
 * be installed if the local change turns out not to have taken effect on
 * the server (rejected, or a no-op that emitted no update).
 */

import deepEqual from 'fast-deep-equal';

import { TRANSIENT_EDGE_FIELDS } from '@huabu/shared/canvas-engine';

import {
  changedUnits,
  PLACEMENT_UNITS,
  readUnit,
  type UnitNode,
  type UnitValue,
} from './propertyUnits';

/** Pseudo-unit: the node itself was created or deleted. */
export const EXISTENCE_UNIT = 'existence';

const SEPARATOR = '\u0000';

export function nodeUnitKey(nodeId: string, unit: string): string {
  return `n${SEPARATOR}${nodeId}${SEPARATOR}${unit}`;
}

export function edgeKey(edgeId: string): string {
  return `e${SEPARATOR}${edgeId}`;
}

/** Direct-child order of one parent (`null` is the root). */
export function orderKey(parentId: string | null | undefined): string {
  return `o${SEPARATOR}${parentId ?? ''}`;
}

export type ParsedKey =
  | { kind: 'node'; nodeId: string; unit: string }
  | { kind: 'edge'; edgeId: string }
  | { kind: 'order'; parentId: string | null };

/** Inverse of {@link nodeUnitKey}, {@link edgeKey} and {@link orderKey}. */
export function parseKey(key: string): ParsedKey | null {
  const [kind, id, ...rest] = key.split(SEPARATOR);
  if (kind === 'n' && id !== undefined && rest.length > 0)
    return { kind: 'node', nodeId: id, unit: rest.join(SEPARATOR) };
  if (kind === 'e' && id) return { kind: 'edge', edgeId: id };
  if (kind === 'o' && id !== undefined)
    return { kind: 'order', parentId: id || null };
  return null;
}

/** The server's value of one node unit, as far as this page knows it. */
export interface WithheldUnit {
  nodeId: string;
  unit: string;
  value: UnitValue;
}

/**
 * Keys one batch holds. A node-unit key maps to the unit's value before the
 * batch (its last confirmed value); existence, edge and order keys map to
 * `null`.
 */
export type HeldKeys = Map<string, WithheldUnit | null>;

interface HeldEntry {
  keys: Set<string>;
}

export class InFlightSet {
  private readonly entries = new Map<string, HeldEntry>();
  /**
   * The server's value of every held node unit: the value it had before the
   * first unconfirmed local change, replaced by any remote value that
   * arrived since and was not applied.
   */
  private readonly confirmed = new Map<string, WithheldUnit>();

  /** Add keys held by `entryId`; repeated calls accumulate. */
  hold(entryId: string, keys: HeldKeys): void {
    let entry = this.entries.get(entryId);
    if (!entry) {
      entry = { keys: new Set() };
      this.entries.set(entryId, entry);
    }
    for (const [key, base] of keys) {
      // An earlier unconfirmed change already recorded the confirmed value;
      // this batch's "before" is that change's optimistic value.
      if (base && !this.isHeld(key)) this.confirmed.set(key, base);
      entry.keys.add(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Whether an unconfirmed local change holds `key`. With `exceptEntryId`
   * that entry's own hold is ignored — the question an echo asks: does a
   * *later* local change still hold this?
   */
  isHeld(key: string, exceptEntryId?: string): boolean {
    for (const [entryId, entry] of this.entries) {
      if (entryId !== exceptEntryId && entry.keys.has(key)) return true;
    }
    return false;
  }

  /** Keep the newest server value of a held node unit instead of applying it. */
  withhold(unit: WithheldUnit): void {
    this.confirmed.set(nodeUnitKey(unit.nodeId, unit.unit), unit);
  }

  /**
   * Drop `entryId`'s holds. Returns the server values to install: for every
   * key no other entry holds and the confirming update did not itself change
   * (`covered`), the last confirmed value. That is the withheld remote
   * value when one arrived, otherwise the value before the local change —
   * the server did not take the change, so it still has that one. A covered
   * key was just written by the confirming update and needs nothing.
   */
  release(entryId: string, covered: ReadonlySet<string>): WithheldUnit[] {
    const entry = this.entries.get(entryId);
    if (!entry) return [];
    this.entries.delete(entryId);
    const freed: WithheldUnit[] = [];
    for (const key of entry.keys) {
      if (this.isHeld(key)) continue;
      const value = this.confirmed.get(key);
      if (!value) continue;
      this.confirmed.delete(key);
      if (!covered.has(key)) freed.push(value);
    }
    return freed;
  }

  /** Forget everything: the page adopted a whole-Space server state. */
  clear(): void {
    this.entries.clear();
    this.confirmed.clear();
  }
}

type UnitEdge = { id: string } & Record<string, unknown>;

function edgesEqual(a: UnitEdge, b: UnitEdge): boolean {
  if (a === b) return true;
  const strip = (edge: UnitEdge): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...edge };
    for (const field of TRANSIENT_EDGE_FIELDS) delete out[field];
    return out;
  };
  return deepEqual(strip(a), strip(b));
}

function childOrders(nodes: readonly UnitNode[]): Map<string, string[]> {
  const byParent = new Map<string, string[]>();
  for (const node of nodes) {
    const key = orderKey(node.parentId as string | undefined);
    const list = byParent.get(key);
    if (list) list.push(node.id);
    else byParent.set(key, [node.id]);
  }
  return byParent;
}

/**
 * Keys a local batch holds: every (node, unit) whose value differs between
 * `prev` and `next`, node and edge existence, and each parent whose
 * direct-child order changed.
 *
 * A node's `position` and `parent` are held together: a position is
 * relative to the parent, so a change to either holds both. An update from
 * another page that changes the one this page did not touch is then kept
 * back with the other, and the page never shows its own coordinates under
 * another page's parent (or the reverse).
 *
 * @param ignoreUnit Units that are not sent through the queue (they are
 *   saved by another writer and protected by its own bookkeeping).
 */
export function deriveHeldKeys(
  prev: { nodes: readonly UnitNode[]; edges: readonly UnitEdge[] },
  next: { nodes: readonly UnitNode[]; edges: readonly UnitEdge[] },
  ignoreUnit: (unit: string) => boolean = () => false,
): HeldKeys {
  const keys: HeldKeys = new Map();

  if (prev.nodes !== next.nodes) {
    const prevById = new Map(prev.nodes.map((node) => [node.id, node]));
    const nextIds = new Set<string>();
    for (const node of next.nodes) {
      nextIds.add(node.id);
      const before = prevById.get(node.id);
      if (!before) {
        keys.set(nodeUnitKey(node.id, EXISTENCE_UNIT), null);
        continue;
      }
      if (before === node) continue;
      const units = changedUnits(before, node);
      if (PLACEMENT_UNITS.some((unit) => units.includes(unit))) {
        for (const unit of PLACEMENT_UNITS)
          if (!units.includes(unit)) units.push(unit);
      }
      for (const unit of units) {
        if (ignoreUnit(unit)) continue;
        keys.set(nodeUnitKey(node.id, unit), {
          nodeId: node.id,
          unit,
          value: readUnit(before, unit),
        });
      }
    }
    for (const node of prev.nodes) {
      if (!nextIds.has(node.id))
        keys.set(nodeUnitKey(node.id, EXISTENCE_UNIT), null);
    }

    const before = childOrders(prev.nodes);
    const after = childOrders(next.nodes);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(key) ?? [];
      const b = after.get(key) ?? [];
      if (a.length !== b.length || a.some((id, index) => id !== b[index]))
        keys.set(key, null);
    }
  }

  if (prev.edges !== next.edges) {
    const prevById = new Map(prev.edges.map((edge) => [edge.id, edge]));
    const nextIds = new Set<string>();
    for (const edge of next.edges) {
      nextIds.add(edge.id);
      const before = prevById.get(edge.id);
      if (!before || !edgesEqual(before, edge))
        keys.set(edgeKey(edge.id), null);
    }
    for (const edge of prev.edges) {
      if (!nextIds.has(edge.id)) keys.set(edgeKey(edge.id), null);
    }
  }

  return keys;
}
