// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { resolveGeometryEdit } from '../geometry';

import type { Node } from '@xyflow/react';

function note(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    type: 'note',
    position: { x: 0, y: 0 },
    style: { width: 400, height: 264 },
    data: { type: 'note', heightMode: 'auto' },
    ...overrides,
  } as Node;
}

describe('resolveGeometryEdit', () => {
  it('leaves an auto note auto when only the width is edited', () => {
    // The regression this guards: since auto heights became
    // materialized, `style.height` is a number in both modes, so
    // carrying it forward would silently pin every note the user
    // resized through the width field.
    expect(resolveGeometryEdit(note(), { width: 155 })).toEqual({
      width: 155,
      height: 'auto',
    });
  });

  it('keeps a pinned height when only the width is edited', () => {
    expect(
      resolveGeometryEdit(
        note({
          style: { width: 400, height: 700 },
          data: { type: 'note', heightMode: 'fixed' },
        }),
        { width: 155 },
      ),
    ).toEqual({ width: 155, height: 700 });
  });

  it('honours an explicitly typed height, which pins the node', () => {
    expect(resolveGeometryEdit(note(), { height: 500 })).toEqual({
      width: 400,
      height: 500,
    });
  });

  it('falls back to the measured width when none is pinned', () => {
    expect(
      resolveGeometryEdit(
        note({ style: {}, measured: { width: 320, height: 100 } }),
        { height: 500 },
      ),
    ).toEqual({ width: 320, height: 500 });
  });

  it('skips a node whose width cannot be resolved', () => {
    expect(
      resolveGeometryEdit(note({ style: {}, measured: undefined }), {
        height: 500,
      }),
    ).toBeNull();
  });

  it('reports always-content types as auto', () => {
    expect(
      resolveGeometryEdit(
        note({ type: 'text', style: { width: 200 }, data: { type: 'text' } }),
        { width: 240 },
      ),
    ).toEqual({ width: 240, height: 'auto' });
  });

  it('preserves the current aspect ratio when width is edited', () => {
    expect(
      resolveGeometryEdit(
        note({ type: 'image', data: { type: 'image', src: 'test.png' } }),
        { width: 600 },
      ),
    ).toEqual({ width: 600, height: 396 });
  });

  it('preserves the current aspect ratio when height is edited', () => {
    expect(
      resolveGeometryEdit(
        note({ type: 'video', data: { type: 'video', src: 'test.mp4' } }),
        { height: 396 },
      ),
    ).toEqual({ width: 600, height: 396 });
  });
});
