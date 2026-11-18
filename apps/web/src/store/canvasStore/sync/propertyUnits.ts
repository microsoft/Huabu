// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Property units: the granularity at which two pages' edits to one node are
 * independent.
 *
 * A node is split into named units. A remote change is applied unit by unit,
 * so a page that moved a node keeps its position while another page's colour
 * change to the same node still lands. The decomposition is exhaustive over
 * the persisted node: applying every changed unit of `prev → next` onto
 * `prev` yields `next`.
 *
 * | Unit                 | Fields                                        |
 * | -------------------- | --------------------------------------------- |
 * | `position`           | `position`                                    |
 * | `size`               | `width`, `height`, top-level `style`          |
 * | `parent`             | `parentId`, `extent`, `expandParent`          |
 * | `data.style.<leaf>`  | one key of `data.style`                       |
 * | `data.properties.<k>`| one custom property of `data.properties`      |
 * | `data.<key>`         | any other `data` key (`label`, `content`, …)  |
 * | `node.<key>`         | any other top-level key (`type`, `zIndex`, …) |
 *
 * React Flow runtime fields (`selected`, `dragging`, `measured`, `resizing`)
 * belong to no unit: they are never taken from another page.
 *
 * `position` and `parent` are separate units but are held together while a
 * local change to either is unconfirmed ({@link PLACEMENT_UNITS}).
 *
 * Pure functions only.
 */

import deepEqual from 'fast-deep-equal';

import { TRANSIENT_NODE_FIELDS } from '@huabu/shared/canvas-engine';

/** Loose node shape shared by React Flow nodes and engine nodes. */
export type UnitNode = { id: string } & Record<string, unknown>;

export const POSITION_UNIT = 'position';
export const SIZE_UNIT = 'size';
export const PARENT_UNIT = 'parent';
/**
 * The units that say where a node is: its parent and its position relative
 * to that parent. Each is a unit of its own for reading and writing, but
 * one is meaningless without the other, so an unconfirmed local change holds
 * them together (see `deriveHeldKeys`).
 */
export const PLACEMENT_UNITS: readonly string[] = [POSITION_UNIT, PARENT_UNIT];
const DATA_STYLE_PREFIX = 'data.style.';
/** One custom property: two writers of different keys never meet. */
export const DATA_PROPERTIES_PREFIX = 'data.properties.';
const DATA_PREFIX = 'data.';
const NODE_PREFIX = 'node.';

const SIZE_FIELDS = ['width', 'height', 'style'] as const;
const PARENT_FIELDS = ['parentId', 'extent', 'expandParent'] as const;
const GROUPED_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'position',
  'data',
  ...SIZE_FIELDS,
  ...PARENT_FIELDS,
  ...TRANSIENT_NODE_FIELDS,
]);

/** A unit's value on one node; `present: false` means the field is absent. */
export interface UnitValue {
  present: boolean;
  value?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(
  source: Record<string, unknown>,
  fields: readonly string[],
): UnitValue {
  const value: Record<string, unknown> = {};
  let present = false;
  for (const field of fields) {
    if (!(field in source) || source[field] === undefined) continue;
    value[field] = source[field];
    present = true;
  }
  return present ? { present, value } : { present };
}

function dataOf(node: UnitNode): Record<string, unknown> {
  return isRecord(node.data) ? node.data : {};
}

function styleOf(node: UnitNode): Record<string, unknown> | undefined {
  const style = dataOf(node).style;
  return isRecord(style) ? style : undefined;
}

function propertiesOf(node: UnitNode): Record<string, unknown> | undefined {
  const properties = dataOf(node).properties;
  return isRecord(properties) ? properties : undefined;
}

/** `data` keys whose value is a bag of independent leaves, with their prefix. */
const LEAF_BAGS: readonly {
  key: string;
  prefix: string;
  of: (node: UnitNode) => Record<string, unknown> | undefined;
}[] = [
  { key: 'style', prefix: DATA_STYLE_PREFIX, of: styleOf },
  { key: 'properties', prefix: DATA_PROPERTIES_PREFIX, of: propertiesOf },
];

/** Every unit name `node` has a value for. */
function unitsOf(node: UnitNode): string[] {
  const units: string[] = [POSITION_UNIT, SIZE_UNIT, PARENT_UNIT];
  const data = dataOf(node);
  for (const key of Object.keys(data)) {
    const bag = LEAF_BAGS.find((entry) => entry.key === key);
    const leaves = bag?.of(node);
    if (bag && leaves) {
      for (const leaf of Object.keys(leaves))
        units.push(`${bag.prefix}${leaf}`);
    } else {
      units.push(`${DATA_PREFIX}${key}`);
    }
  }
  for (const key of Object.keys(node)) {
    if (!GROUPED_FIELDS.has(key)) units.push(`${NODE_PREFIX}${key}`);
  }
  return units;
}

/** Read one unit's value from `node`. */
export function readUnit(node: UnitNode, unit: string): UnitValue {
  if (unit === POSITION_UNIT) {
    return node.position === undefined
      ? { present: false }
      : { present: true, value: node.position };
  }
  if (unit === SIZE_UNIT) return pick(node, SIZE_FIELDS);
  if (unit === PARENT_UNIT) return pick(node, PARENT_FIELDS);
  const bag = LEAF_BAGS.find((entry) => unit.startsWith(entry.prefix));
  if (bag) {
    const leaf = unit.slice(bag.prefix.length);
    const leaves = bag.of(node);
    return leaves && Object.hasOwn(leaves, leaf) && leaves[leaf] !== undefined
      ? { present: true, value: leaves[leaf] }
      : { present: false };
  }
  if (unit.startsWith(DATA_PREFIX)) {
    const key = unit.slice(DATA_PREFIX.length);
    const data = dataOf(node);
    return key in data && data[key] !== undefined
      ? { present: true, value: data[key] }
      : { present: false };
  }
  if (unit.startsWith(NODE_PREFIX)) {
    const key = unit.slice(NODE_PREFIX.length);
    return key in node && node[key] !== undefined
      ? { present: true, value: node[key] }
      : { present: false };
  }
  return { present: false };
}

function unitValuesEqual(a: UnitValue, b: UnitValue): boolean {
  if (a.present !== b.present) return false;
  return !a.present || deepEqual(a.value, b.value);
}

/** Unit names whose value differs between `prev` and `next`. */
export function changedUnits(prev: UnitNode, next: UnitNode): string[] {
  const names = new Set([...unitsOf(prev), ...unitsOf(next)]);
  const changed: string[] = [];
  for (const unit of names) {
    if (!unitValuesEqual(readUnit(prev, unit), readUnit(next, unit)))
      changed.push(unit);
  }
  return changed;
}

function writeFields<T extends UnitNode>(
  node: T,
  fields: readonly string[],
  value: UnitValue,
): T {
  const out: Record<string, unknown> = { ...node };
  const source = value.present && isRecord(value.value) ? value.value : {};
  for (const field of fields) {
    if (field in source) out[field] = source[field];
    else delete out[field];
  }
  return out as T;
}

/** Return a copy of `node` with one unit set to `value`. */
export function writeUnit<T extends UnitNode>(
  node: T,
  unit: string,
  value: UnitValue,
): T {
  if (unit === POSITION_UNIT) {
    if (!value.present) return node;
    return { ...node, position: value.value };
  }
  if (unit === SIZE_UNIT) return writeFields(node, SIZE_FIELDS, value);
  if (unit === PARENT_UNIT) return writeFields(node, PARENT_FIELDS, value);
  const bag = LEAF_BAGS.find((entry) => unit.startsWith(entry.prefix));
  if (bag) {
    const leaf = unit.slice(bag.prefix.length);
    const leaves = { ...(bag.of(node) ?? {}) };
    // A leaf may be named like a prototype member (`__proto__`).
    if (value.present)
      Object.defineProperty(leaves, leaf, {
        value: value.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    else delete leaves[leaf];
    const data = { ...dataOf(node) };
    // An emptied bag is dropped so removing the last leaf matches a node
    // that never had one.
    if (Object.keys(leaves).length > 0) data[bag.key] = leaves;
    else delete data[bag.key];
    return { ...node, data };
  }
  if (unit.startsWith(DATA_PREFIX)) {
    const key = unit.slice(DATA_PREFIX.length);
    const data = { ...dataOf(node) };
    if (value.present) data[key] = value.value;
    else delete data[key];
    return { ...node, data };
  }
  if (unit.startsWith(NODE_PREFIX)) {
    const key = unit.slice(NODE_PREFIX.length);
    const out: Record<string, unknown> = { ...node };
    if (value.present) out[key] = value.value;
    else delete out[key];
    return out as T;
  }
  return node;
}

/** Copy the named units from `source` onto `target`. */
export function applyUnits<T extends UnitNode>(
  target: T,
  source: UnitNode,
  units: Iterable<string>,
): T {
  let out = target;
  for (const unit of units) out = writeUnit(out, unit, readUnit(source, unit));
  return out;
}
