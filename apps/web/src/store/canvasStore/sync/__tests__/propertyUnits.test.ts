// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  applyUnits,
  changedUnits,
  readUnit,
  writeUnit,
  type UnitNode,
} from '../propertyUnits';

const base: UnitNode = {
  id: 'node-x',
  type: 'note',
  position: { x: 10, y: 20 },
  style: { width: 300, height: 200 },
  parentId: 'frame-1',
  selected: true,
  measured: { width: 300, height: 200 },
  data: {
    label: 'X',
    content: 'body',
    heightMode: 'fixed',
    style: { accent: 'white', fontSize: 14 },
  },
};

describe('property units', () => {
  it('names each independent property that changed', () => {
    const next: UnitNode = {
      ...base,
      position: { x: 50, y: 20 },
      style: { width: 320, height: 200 },
      parentId: undefined,
      zIndex: 3,
      data: {
        ...(base.data as object),
        label: 'Renamed',
        style: { accent: 'blue', fontSize: 14 },
      },
    };
    expect(changedUnits(base, next).sort()).toEqual(
      [
        'position',
        'size',
        'parent',
        'data.label',
        'data.style.accent',
        'node.zIndex',
      ].sort(),
    );
  });

  it('ignores React Flow runtime fields and equal values in new objects', () => {
    const next: UnitNode = {
      ...base,
      selected: false,
      dragging: true,
      measured: { width: 1, height: 1 },
      position: { x: 10, y: 20 },
      data: JSON.parse(JSON.stringify(base.data)),
    };
    expect(changedUnits(base, next)).toEqual([]);
  });

  it('applying every changed unit of prev → next onto prev gives next', () => {
    const next: UnitNode = {
      id: 'node-x',
      type: 'text',
      position: { x: 1, y: 2 },
      style: { width: 100 },
      hidden: true,
      data: {
        content: 'other',
        style: { fontSize: 20, italic: true },
        added: [1, 2],
      },
    };
    const { selected, measured, ...persisted } = applyUnits(
      base,
      next,
      changedUnits(base, next),
    );
    expect(persisted).toEqual(next);
    // Runtime fields stay this page's own.
    expect(selected).toBe(true);
    expect(measured).toEqual(base.measured);
  });

  it('writes one unit and leaves the others as they were', () => {
    const moved = writeUnit(base, 'position', {
      present: true,
      value: { x: 99, y: 99 },
    });
    expect(moved.position).toEqual({ x: 99, y: 99 });
    expect(moved.data).toBe(base.data);

    const recoloured = writeUnit(base, 'data.style.accent', {
      present: true,
      value: 'blue',
    });
    expect(readUnit(recoloured, 'data.style.accent').value).toBe('blue');
    expect(readUnit(recoloured, 'data.style.fontSize').value).toBe(14);
    expect(recoloured.position).toBe(base.position);

    const cleared = writeUnit(base, 'data.label', { present: false });
    expect('label' in (cleared.data as object)).toBe(false);
    expect(readUnit(cleared, 'data.content').value).toBe('body');
  });

  it('removing the last style leaf removes the style bag', () => {
    const node: UnitNode = { id: 'n', data: { style: { accent: 'red' } } };
    const cleared = writeUnit(node, 'data.style.accent', { present: false });
    expect(cleared.data).toEqual({});
  });

  it('treats size as one unit across width, height and top-level style', () => {
    const next = { ...base, style: { width: 300, height: 260 } };
    expect(changedUnits(base, next)).toEqual(['size']);
    expect(applyUnits(base, next, ['size']).style).toEqual({
      width: 300,
      height: 260,
    });
  });

  it('treats every custom property as a unit of its own', () => {
    const prev: UnitNode = {
      ...base,
      data: {
        ...(base.data as object),
        properties: { Year: 2024, Venue: 'CHI' },
      },
    };
    const next: UnitNode = {
      ...base,
      data: {
        ...(base.data as object),
        properties: { Year: 2025, Tag: ['a'] },
      },
    };
    expect(changedUnits(prev, next).sort()).toEqual([
      'data.properties.Tag',
      'data.properties.Venue',
      'data.properties.Year',
    ]);
    // One writer's key is applied beside another's.
    const merged = applyUnits(prev, next, ['data.properties.Tag']);
    expect((merged.data as { properties: unknown }).properties).toEqual({
      Year: 2024,
      Venue: 'CHI',
      Tag: ['a'],
    });
    expect(applyUnits(prev, next, changedUnits(prev, next))).toEqual(next);
  });

  it('drops the property bag with its last key, and takes a key named like a prototype member', () => {
    const one: UnitNode = { id: 'n', data: { properties: { Year: 2024 } } };
    const none = writeUnit(one, 'data.properties.Year', { present: false });
    expect(none.data).toEqual({});
    const odd = writeUnit(one, 'data.properties.__proto__', {
      present: true,
      value: 'x',
    });
    expect(readUnit(odd, 'data.properties.__proto__')).toEqual({
      present: true,
      value: 'x',
    });
    expect(
      Object.keys((odd.data as { properties: object }).properties),
    ).toEqual(['Year', '__proto__']);
  });
});
